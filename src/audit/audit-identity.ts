/** Stable installation-local pseudonyms for sensitive audit identifiers. */
import { createHmac, randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type AuditIdentityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "audit_events" | "audit_identity_keys" | "execution_identity_contexts"
>;
type AuditIdentityKeyRow = Pick<
  Selectable<AuditIdentityDatabase["audit_identity_keys"]>,
  "key_id" | "key"
>;

const AUDIT_IDENTITY_SINGLETON_ID = 1;
const AUDIT_IDENTITY_KEY_BYTES = 32;
const AUDIT_IDENTITY_KEY_ID_BYTES = 16;
const AUDIT_IDENTITY_KEY_ID_RE = /^[a-f0-9]{32}$/u;
const AUDIT_IDENTITY_DOMAIN = "openclaw.audit.identity.v1";
// A newly created key stays transaction-local until the outer writer commits.
const identityByDatabase = new WeakMap<EngineConnection, AuditIdentityKey>();

type AuditIdentityKey = {
  keyId: string;
  key: Uint8Array;
};

type AuditIdentityKind = "account" | "actor" | "conversation" | "message" | "target";
type ExecutionIdentityRefKind =
  | "credential"
  | "domain"
  | "evidence"
  | "grant"
  | "principal"
  | "runtime"
  | "target";

function registerAuditIdentityKeyForRedaction(key: Uint8Array): void {
  const bytes = Buffer.from(key);
  registerSecretValueForRedaction(bytes.toString("hex"));
  registerSecretValueForRedaction(bytes.toString("base64url"));
}

function parseAuditIdentityKey(row: AuditIdentityKeyRow): AuditIdentityKey {
  if (
    typeof row.key_id !== "string" ||
    !AUDIT_IDENTITY_KEY_ID_RE.test(row.key_id) ||
    !(row.key instanceof Uint8Array) ||
    row.key.byteLength !== AUDIT_IDENTITY_KEY_BYTES
  ) {
    // Stable pseudonyms are an audit integrity boundary. Never silently rotate
    // or fall back to an unkeyed digest when persisted key material is damaged.
    throw new Error("audit identity key is corrupt");
  }
  const key = Buffer.from(row.key);
  registerAuditIdentityKeyForRedaction(key);
  return { keyId: row.key_id, key };
}

/** Load the stable audit identity key or create it on first use. */
export function loadOrCreateAuditIdentityKey(db: EngineConnection): AuditIdentityKey {
  const cached = identityByDatabase.get(db);
  if (cached) {
    return cached;
  }
  const kysely = getNodeSqliteKysely<AuditIdentityDatabase>(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_identity_keys")
      .select(["key_id", "key"])
      .where("id", "=", AUDIT_IDENTITY_SINGLETON_ID),
  );
  if (existing) {
    const identity = parseAuditIdentityKey(existing);
    identityByDatabase.set(db, identity);
    return identity;
  }
  const retainedMessage = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("audit_events").select("sequence").where("kind", "=", "message").limit(1),
  );
  const hasExecutionContextTable = tableExists(db, "execution_identity_contexts");
  const retainedExecutionContext = hasExecutionContextTable
    ? executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("execution_identity_contexts").select("context_id").limit(1),
      )
    : undefined;
  if (retainedMessage || retainedExecutionContext) {
    // A missing key with retained refs would split correlation on restart.
    // Fail closed instead of silently rotating away from the persisted key id.
    throw new Error("audit identity key is missing");
  }

  const candidate = {
    id: AUDIT_IDENTITY_SINGLETON_ID,
    key_id: randomBytes(AUDIT_IDENTITY_KEY_ID_BYTES).toString("hex"),
    key: randomBytes(AUDIT_IDENTITY_KEY_BYTES),
    created_at: Date.now(),
  };
  executeSqliteQuerySync(db, kysely.insertInto("audit_identity_keys").values(candidate));
  const identity = { keyId: candidate.key_id, key: candidate.key };
  registerAuditIdentityKeyForRedaction(identity.key);
  stageSqliteTransactionState(db, {
    commit: () => {},
    rollback: () => identityByDatabase.delete(db),
    invalidate: () => identityByDatabase.delete(db),
  });
  identityByDatabase.set(db, identity);
  return identity;
}

/** Forget transaction-local key state after a failed or rolled-back write. */
export function clearAuditIdentityKeyCacheForDatabase(db: EngineConnection): void {
  identityByDatabase.delete(db);
}

/** Produce a stable, domain-separated pseudonym without retaining raw identity bytes. */
export function pseudonymizeAuditIdentity(params: {
  identity: AuditIdentityKey;
  kind: AuditIdentityKind;
  channel: string;
  accountId?: string;
  conversationId?: string;
  value: string | undefined;
}): string | undefined {
  if (params.value === undefined || params.value.length === 0) {
    return undefined;
  }
  const digest = createHmac("sha256", params.identity.key)
    .update(
      JSON.stringify([
        AUDIT_IDENTITY_DOMAIN,
        params.kind,
        params.channel,
        params.accountId ?? null,
        params.kind === "message" ? (params.conversationId ?? null) : null,
        params.value,
      ]),
      "utf8",
    )
    .digest("hex");
  return `hmac-sha256:v1:${params.identity.keyId}:${digest}`;
}

/** Project one execution-identity ref without retaining its raw owner value. */
export function pseudonymizeExecutionIdentityRef(params: {
  db: EngineConnection;
  kind: ExecutionIdentityRefKind;
  scope: string;
  value: string;
}): string {
  if (!params.scope || !params.value) {
    throw new Error("execution identity HMAC scope and value must be non-empty");
  }
  const identity = loadOrCreateAuditIdentityKey(params.db);
  const digest = createHmac("sha256", identity.key)
    .update(
      JSON.stringify([
        "openclaw.audit.execution-identity.v1",
        params.kind,
        params.scope,
        params.value,
      ]),
      "utf8",
    )
    .digest("hex");
  return `hmac-sha256:v1:${identity.keyId}:${digest}`;
}
