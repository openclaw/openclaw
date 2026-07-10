import { createHash, randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHARE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;
const SHARE_CODE_RANDOM_BYTES = 6;
const SHARE_CODE_MINT_ATTEMPTS = 10;
const DEFAULT_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const log = createSubsystemLogger("gateway/guest-grants");

type GuestGrantDatabase = Pick<OpenClawStateKyselyDatabase, "guest_grants" | "guest_joins">;
type GuestGrantRow = Selectable<GuestGrantDatabase["guest_grants"]>;
type GuestJoinRow = Selectable<GuestGrantDatabase["guest_joins"]>;

export type GuestInvitedPrincipal = {
  issuer: "deva";
  subject: string;
};

export type GuestGrant = {
  grantId: string;
  sessionKey: string;
  mode: "viewer";
  audience: "open" | "deva-user";
  invitedPrincipal?: GuestInvitedPrincipal;
  codeHash: string;
  createdBy: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs?: number;
  replayPolicy: "share-start" | "full";
  maxConcurrentGuests?: number;
};

export type GuestJoin = {
  guestId: string;
  grantId: string;
  devaUserId?: string;
  displayName: string;
  tokenHash: string;
  createdAtMs: number;
  lastSeenMs: number;
};

type GuestGrantStoreOptions = {
  stateDir?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  sweepIntervalMs?: number;
};

type CreateGuestGrantParams = {
  sessionKey: string;
  audience: GuestGrant["audience"];
  invitedPrincipal?: GuestInvitedPrincipal;
  createdBy: string;
  expiresAtMs?: number;
  replayPolicy?: GuestGrant["replayPolicy"];
  maxConcurrentGuests?: number;
};

type CreateGuestJoinParams = {
  grantId: string;
  token: string;
  devaUserId?: string;
};

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function mintShareCode(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(SHARE_CODE_RANDOM_BYTES);
  const characters = Array.from(bytes, (byte) => SHARE_CODE_ALPHABET.charAt(byte & 31));
  return `${characters.slice(0, 3).join("")}-${characters.slice(3).join("")}`;
}

function normalizeShareCode(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  return SHARE_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

function parseInvitedPrincipal(value: string | null): GuestInvitedPrincipal | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { issuer?: unknown }).issuer !== "deva" ||
    typeof (parsed as { subject?: unknown }).subject !== "string"
  ) {
    throw new Error("invalid invited principal in guest grant store");
  }
  return { issuer: "deva", subject: (parsed as { subject: string }).subject };
}

function grantFromRow(row: GuestGrantRow): GuestGrant {
  if (row.mode !== "viewer") {
    throw new Error("invalid mode in guest grant store");
  }
  if (row.audience !== "open" && row.audience !== "deva-user") {
    throw new Error("invalid audience in guest grant store");
  }
  if (row.replay_policy !== "share-start" && row.replay_policy !== "full") {
    throw new Error("invalid replay policy in guest grant store");
  }
  const invitedPrincipal = parseInvitedPrincipal(row.invited_principal_json);
  if ((row.audience === "deva-user") !== Boolean(invitedPrincipal)) {
    throw new Error("invalid audience binding in guest grant store");
  }
  return {
    grantId: row.grant_id,
    sessionKey: row.session_key,
    mode: "viewer",
    audience: row.audience,
    ...(invitedPrincipal ? { invitedPrincipal } : {}),
    codeHash: row.code_hash,
    createdBy: row.created_by,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    ...(row.revoked_at_ms === null ? {} : { revokedAtMs: row.revoked_at_ms }),
    replayPolicy: row.replay_policy,
    ...(row.max_concurrent_guests === null
      ? {}
      : { maxConcurrentGuests: row.max_concurrent_guests }),
  };
}

function joinFromRow(row: GuestJoinRow): GuestJoin {
  return {
    guestId: row.guest_id,
    grantId: row.grant_id,
    ...(row.deva_user_id === null ? {} : { devaUserId: row.deva_user_id }),
    displayName: row.display_name,
    tokenHash: row.token_hash,
    createdAtMs: row.created_at_ms,
    lastSeenMs: row.last_seen_ms,
  };
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

export class GuestGrantStore {
  readonly filePath: string;
  private readonly databaseOptions: OpenClawStateDatabaseOptions;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  constructor(options: GuestGrantStoreOptions = {}) {
    const env = options.stateDir
      ? { ...process.env, OPENCLAW_STATE_DIR: options.stateDir }
      : process.env;
    const database = openOpenClawStateDatabase({ env });
    this.filePath = database.path;
    this.databaseOptions = { path: database.path };
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new Error("sweepIntervalMs must be a positive integer");
    }
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepExpired();
      } catch (error) {
        log.warn(`guest grant expiry sweep failed: ${String(error)}`);
      }
    }, sweepIntervalMs);
    this.sweepTimer.unref();
  }

  createGrant(params: CreateGuestGrantParams): { grant: GuestGrant; code: string } {
    const sessionKey = requireNonEmpty(params.sessionKey, "sessionKey");
    const createdBy = requireNonEmpty(params.createdBy, "createdBy");
    const invitedPrincipal = params.invitedPrincipal
      ? {
          issuer: params.invitedPrincipal.issuer,
          subject: requireNonEmpty(params.invitedPrincipal.subject, "invitedPrincipal.subject"),
        }
      : undefined;
    if (params.audience !== "open" && params.audience !== "deva-user") {
      throw new Error("audience must be open or deva-user");
    }
    const replayPolicy = params.replayPolicy ?? "share-start";
    if (replayPolicy !== "share-start" && replayPolicy !== "full") {
      throw new Error("replayPolicy must be share-start or full");
    }
    const now = this.now();
    const expiresAtMs = params.expiresAtMs ?? now + DEFAULT_GRANT_TTL_MS;
    if (!Number.isInteger(expiresAtMs) || expiresAtMs <= now) {
      throw new Error("expiresAtMs must be an integer in the future");
    }
    if (
      params.maxConcurrentGuests !== undefined &&
      (!Number.isInteger(params.maxConcurrentGuests) || params.maxConcurrentGuests <= 0)
    ) {
      throw new Error("maxConcurrentGuests must be a positive integer");
    }
    if (params.audience === "deva-user" && !invitedPrincipal) {
      throw new Error("invitedPrincipal is required for deva-user grants");
    }
    if (params.audience === "open" && invitedPrincipal) {
      throw new Error("invitedPrincipal is only valid for deva-user grants");
    }

    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
      const grantId = randomUUID();
      for (let attempt = 0; attempt < SHARE_CODE_MINT_ATTEMPTS; attempt += 1) {
        const code = mintShareCode(this.randomBytes);
        const codeHash = hashSecret(code);
        const collision = executeSqliteQueryTakeFirstSync(
          database.db,
          db.selectFrom("guest_grants").select("grant_id").where("code_hash", "=", codeHash),
        );
        if (collision) {
          continue;
        }
        const grant: GuestGrant = {
          grantId,
          sessionKey,
          mode: "viewer",
          audience: params.audience,
          ...(invitedPrincipal ? { invitedPrincipal } : {}),
          codeHash,
          createdBy,
          createdAtMs: now,
          expiresAtMs,
          replayPolicy,
          ...(params.maxConcurrentGuests === undefined
            ? {}
            : { maxConcurrentGuests: params.maxConcurrentGuests }),
        };
        executeSqliteQuerySync(
          database.db,
          db.insertInto("guest_grants").values({
            grant_id: grant.grantId,
            session_key: grant.sessionKey,
            mode: grant.mode,
            audience: grant.audience,
            invited_principal_json: grant.invitedPrincipal
              ? JSON.stringify(grant.invitedPrincipal)
              : null,
            code_hash: grant.codeHash,
            created_by: grant.createdBy,
            created_at_ms: grant.createdAtMs,
            expires_at_ms: grant.expiresAtMs,
            revoked_at_ms: null,
            replay_policy: grant.replayPolicy,
            max_concurrent_guests: grant.maxConcurrentGuests ?? null,
          }),
        );
        return { grant, code };
      }
      throw new Error("unable to mint a unique guest share code");
    }, this.databaseOptions);
  }

  getGrant(grantId: string): GuestGrant | undefined {
    const database = openOpenClawStateDatabase(this.databaseOptions);
    const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("guest_grants").selectAll().where("grant_id", "=", grantId),
    );
    return row ? grantFromRow(row) : undefined;
  }

  listGrants(params: { sessionKey?: string } = {}): GuestGrant[] {
    const database = openOpenClawStateDatabase(this.databaseOptions);
    const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
    let query = db.selectFrom("guest_grants").selectAll();
    if (params.sessionKey !== undefined) {
      query = query.where("session_key", "=", requireNonEmpty(params.sessionKey, "sessionKey"));
    }
    return executeSqliteQuerySync(
      database.db,
      query.orderBy("created_at_ms", "desc").orderBy("grant_id", "asc"),
    ).rows.map(grantFromRow);
  }

  // Share codes are intentionally short for human entry. Any future network redemption
  // boundary must rate-limit by both caller and code before invoking this lookup.
  findRedeemableGrant(code: string): GuestGrant | undefined {
    const normalizedCode = normalizeShareCode(code);
    if (!normalizedCode) {
      return undefined;
    }
    const database = openOpenClawStateDatabase(this.databaseOptions);
    const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("guest_grants").selectAll().where("code_hash", "=", hashSecret(normalizedCode)),
    );
    if (!row || row.revoked_at_ms !== null || row.expires_at_ms <= this.now()) {
      return undefined;
    }
    return grantFromRow(row);
  }

  revokeGrant(grantId: string): GuestGrant | undefined {
    const now = this.now();
    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
      const current = executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("guest_grants").selectAll().where("grant_id", "=", grantId),
      );
      if (!current) {
        return undefined;
      }
      if (current.revoked_at_ms !== null) {
        throw new Error("guest grant already revoked");
      }
      executeSqliteQuerySync(
        database.db,
        db.updateTable("guest_grants").set({ revoked_at_ms: now }).where("grant_id", "=", grantId),
      );
      return grantFromRow({ ...current, revoked_at_ms: now });
    }, this.databaseOptions);
  }

  sweepExpired(): number {
    const now = this.now();
    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("guest_grants")
          .set({ revoked_at_ms: now })
          .where("revoked_at_ms", "is", null)
          .where("expires_at_ms", "<=", now),
      );
      return Number(result.numAffectedRows ?? 0);
    }, this.databaseOptions);
  }

  createJoin(params: CreateGuestJoinParams): GuestJoin {
    const grantId = requireNonEmpty(params.grantId, "grantId");
    const tokenHash = hashSecret(requireNonEmpty(params.token, "token"));
    const devaUserId =
      params.devaUserId === undefined
        ? undefined
        : requireNonEmpty(params.devaUserId, "devaUserId");
    const now = this.now();
    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
      const grant = executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("guest_grants").selectAll().where("grant_id", "=", grantId),
      );
      if (!grant || grant.revoked_at_ms !== null || grant.expires_at_ms <= now) {
        throw new Error("guest grant is not redeemable");
      }
      const guestGrant = grantFromRow(grant);
      if (
        guestGrant.audience === "deva-user" &&
        guestGrant.invitedPrincipal?.subject !== devaUserId
      ) {
        throw new Error("guest identity does not match invite");
      }
      if (guestGrant.maxConcurrentGuests !== undefined) {
        const joinCountRow = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("guest_joins")
            .select((expression) => expression.fn.countAll<number | bigint>().as("count"))
            .where("grant_id", "=", grantId),
        );
        const rawJoinCount = joinCountRow?.count ?? 0;
        const joinCount = typeof rawJoinCount === "bigint" ? Number(rawJoinCount) : rawJoinCount;
        if (joinCount >= guestGrant.maxConcurrentGuests) {
          throw new Error("guest grant has reached its guest limit");
        }
      }
      const guestNumber = grant.next_guest_number;
      const guestId = `guest:${grantId}:${guestNumber}`;
      const displayName = `Guest ${guestNumber}`;
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("guest_grants")
          .set({ next_guest_number: guestNumber + 1 })
          .where("grant_id", "=", grantId),
      );
      executeSqliteQuerySync(
        database.db,
        db.insertInto("guest_joins").values({
          guest_id: guestId,
          grant_id: grantId,
          guest_number: guestNumber,
          deva_user_id: devaUserId ?? null,
          display_name: displayName,
          token_hash: tokenHash,
          created_at_ms: now,
          last_seen_ms: now,
        }),
      );
      return {
        guestId,
        grantId,
        ...(devaUserId ? { devaUserId } : {}),
        displayName,
        tokenHash,
        createdAtMs: now,
        lastSeenMs: now,
      };
    }, this.databaseOptions);
  }

  listJoins(grantId: string): GuestJoin[] {
    const database = openOpenClawStateDatabase(this.databaseOptions);
    const db = getNodeSqliteKysely<GuestGrantDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("guest_joins")
        .selectAll()
        .where("grant_id", "=", requireNonEmpty(grantId, "grantId"))
        .orderBy("guest_number", "asc"),
    ).rows.map(joinFromRow);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.sweepTimer);
  }
}
