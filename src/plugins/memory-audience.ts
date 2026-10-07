import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { MemoryAudience, MemoryCallerContext } from "./memory-provider-types.js";

const MAX_LINEAGE_HOPS = 64;
const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/;

type GenerationLease = Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;

// One record per minted audience. A delegated record owns its child-session
// lease and borrows its parent's record, so either side going stale rejects it.
type AudienceRecord = {
  parent?: AudienceRecord;
  leases: GenerationLease[];
  state: "current" | "stale" | "released";
  holders: number;
};

/** A host-minted audience plus the owner-held release for its session leases. */
export type MemoryAudienceGrant = { audience: MemoryAudience; release: () => void };

/**
 * Why no audience was granted, classified by its repair:
 * - `stale-lineage`: the session's recorded lineage no longer matches its ancestors or
 *   predates lineage receipts; only respawning or recreating the session restores access.
 * - `unverified`: storage could not verify the lineage now; a later turn resolves again.
 * - `ineligible`: the lineage carries no audience by design, for example a host-run,
 *   cross-agent, rowless-parent, or chat-less root session.
 */
type MemoryAudienceDenialKind = "stale-lineage" | "unverified" | "ineligible";

/** Resolution outcome; a denial names why no memory audience was granted. */
export type MemoryAudienceResolution =
  | ({ status: "granted" } & MemoryAudienceGrant)
  | { status: "denied"; kind: MemoryAudienceDenialKind; reason: string };

const hostAudiences = new WeakSet<object>();
const audienceRecords = new WeakMap<object, AudienceRecord>();
const audienceSessionKeys = new WeakMap<object, string>();

function releaseRecordLeases(record: AudienceRecord): void {
  for (const lease of record.leases.splice(0)) {
    lease.release();
  }
}

// Owners release leases deterministically; collection is only the backstop
// for an owner that threw before its release ran.
const collectedAudienceRecords = new FinalizationRegistry<AudienceRecord>((record) => {
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    current.holders -= 1;
    if (current.holders > 0) {
      return;
    }
    releaseRecordLeases(current);
  }
});

function isAgentSessionKey(sessionKey: string, agentId: string): boolean {
  return parseAgentSessionKey(sessionKey)?.agentId === agentId;
}

function isSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

function resolveGenerationStorePath(agentId: string, sessionKey: string, storePath: string) {
  return isIncognitoSessionKey(sessionKey)
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId })
    : storePath;
}

// Canonical session reads run on the read-only worker, never the Gateway main thread.
async function readEntryInWorker(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  assertCallerCurrent: () => void;
}): Promise<SessionEntry | undefined> {
  const read = await withSessionEntryReadOnlyInWorker(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    params.assertCallerCurrent,
    async (result) => result,
  );
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

// The session owner's generation lease keeps later currency checks synchronous
// and read-free: committed row publications advance or revoke its facts.
async function leaseSessionGeneration(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  /** Undefined leases the row's absence: any later row for the key revokes it. */
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
}): Promise<GenerationLease | undefined> {
  try {
    return await prepareSessionGenerationFacts({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: resolveGenerationStorePath(params.agentId, params.sessionKey, params.storePath),
      sessionId: params.entry?.sessionId ?? null,
      lifecycleRevision: params.entry?.lifecycleRevision ?? null,
    });
  } catch (error) {
    if (isSessionDeliveryGenerationRevokedError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertRecordCurrent(record: AudienceRecord): void {
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    if (current.state === "released") {
      throw new Error("memory audience was released by its owner");
    }
    if (current.state === "stale") {
      throw new Error("memory audience is no longer current");
    }
    for (const lease of current.leases) {
      try {
        lease.assertCurrent();
      } catch (error) {
        // A changed incarnation is permanent for this grant even if a later
        // write rotates back; a pending publication only fails this check.
        if (isSessionDeliveryGenerationRevokedError(error)) {
          current.state = "stale";
          releaseRecordLeases(current);
          throw new Error("memory audience is no longer current", { cause: error });
        }
        throw new Error("memory audience currency is unavailable; retry the operation", {
          cause: error,
        });
      }
    }
  }
}

function mintMemoryAudience(
  audience: MemoryAudience,
  sessionKey: string,
  record: AudienceRecord,
): MemoryAudienceGrant {
  const frozen = Object.freeze(audience);
  hostAudiences.add(frozen);
  audienceRecords.set(frozen, record);
  audienceSessionKeys.set(frozen, sessionKey);
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    current.holders += 1;
  }
  collectedAudienceRecords.register(frozen, record);
  return {
    audience: frozen,
    release: () => {
      if (record.state !== "current") {
        return;
      }
      record.state = "released";
      releaseRecordLeases(record);
    },
  };
}

type MemoryAudienceResolutionParams = {
  agentId: string;
  sessionKey: string;
  sessionId: string | undefined;
  senderIsOwner: boolean | undefined;
  /** Store that admitted the turn; lineage hops for the same agent share it. */
  storePath: string;
  assertCallerCurrent?: () => void;
};

/**
 * Resolve from the current entry already admitted by the host turn owner.
 * Parent rows are read on the read-only worker; every hop holds a session
 * generation lease that is rechecked after the final await, before minting.
 */
export async function resolveMemoryAudienceFromEntry(
  params: MemoryAudienceResolutionParams,
  admittedEntry: SessionEntry,
): Promise<MemoryAudienceResolution> {
  let { sessionKey, sessionId, senderIsOwner } = params;
  const { agentId, storePath } = params;
  const assertCallerCurrent = params.assertCallerCurrent ?? (() => {});
  const seen = new Set<string>();
  const record: AudienceRecord = { leases: [], state: "current", holders: 0 };
  let requiredLifecycleRevision: string | undefined;
  const deny = (kind: MemoryAudienceDenialKind, reason: string): MemoryAudienceResolution => {
    releaseRecordLeases(record);
    return { status: "denied", kind, reason };
  };

  try {
    for (let depth = 0; depth < MAX_LINEAGE_HOPS; depth += 1) {
      // Every hop must remain within the configured agent and exact durable
      // session incarnation. Session-key shape alone never grants authority.
      if (
        !isAgentSessionKey(sessionKey, agentId) ||
        !isSessionId(sessionId) ||
        seen.has(sessionKey)
      ) {
        return deny(
          "ineligible",
          `session lineage at ${sessionKey} is malformed, cyclic, or cross-agent`,
        );
      }
      seen.add(sessionKey);
      // A turn admission already owns its current row. Reuse that prepared fact
      // at depth zero; only delegated parent hops need another canonical read.
      const entry =
        depth === 0
          ? admittedEntry
          : await readEntryInWorker({ agentId, sessionKey, storePath, assertCallerCurrent });
      if (
        !entry ||
        entry.sessionId !== sessionId ||
        (depth > 0 && entry.lifecycleRevision !== requiredLifecycleRevision)
      ) {
        // The admitted row moving under this turn is transient. An ancestor reset or
        // removal after the spawn is permanent: the receipt names a lost incarnation.
        if (depth === 0) {
          return deny("unverified", `session ${sessionKey} no longer matches its admitted turn`);
        }
        return deny(
          "stale-lineage",
          `session ${params.sessionKey} has stale lineage: ancestor ${sessionKey} was reset or removed after its child was spawned. Respawn or recreate it from a current session to restore memory access; resetting it keeps the stale lineage.`,
        );
      }
      // The lease re-verifies this exact incarnation against current storage,
      // so a change between the read above and here denies the grant.
      const lease = await leaseSessionGeneration({ agentId, sessionKey, storePath, entry });
      if (!lease) {
        return deny(
          "unverified",
          `session ${sessionKey} changed while its memory audience was resolved`,
        );
      }
      record.leases.push(lease);

      if (entry.spawnedBy !== undefined) {
        // A child inherits only the owner bit and exact parent incarnation stamped
        // by the spawn owner. Its launch turn and copied chat metadata are not grants.
        // Every receipt carries the owner bit; a parent row without a lifecycle
        // revision (such as a channel-created row) is recorded by its absence.
        if (typeof entry.spawnedBySenderIsOwner !== "boolean") {
          return deny(
            "stale-lineage",
            `spawned session ${sessionKey} predates memory lineage receipts (spawnedBySenderIsOwner), so it has no inherited memory audience. Respawn it from its parent session to restore memory access.`,
          );
        }
        // Voice consult children record no navigation parent; a recorded one must agree.
        if (
          !entry.spawnedBy ||
          (entry.parentSessionKey !== undefined && entry.parentSessionKey !== entry.spawnedBy) ||
          !isSessionId(entry.spawnedBySessionId) ||
          entry.parentSessionLifecycleRevision === ""
        ) {
          return deny("ineligible", `spawned session ${sessionKey} has malformed lineage receipts`);
        }
        sessionKey = entry.spawnedBy;
        sessionId = entry.spawnedBySessionId;
        requiredLifecycleRevision = entry.parentSessionLifecycleRevision;
        senderIsOwner = entry.spawnedBySenderIsOwner;
        continue;
      }

      // Revalidate every captured hop after the final await, before minting.
      assertCallerCurrent();
      assertRecordCurrent(record);
      // Only the durable root chat type selects the partition. Thread-shaped
      // keys intentionally receive no special interpretation here.
      if (entry.chatType === "direct" && senderIsOwner === true) {
        return {
          status: "granted",
          ...mintMemoryAudience({ kind: "owner-private", agentId }, params.sessionKey, record),
        };
      }
      if (
        entry.chatType === "direct" ||
        entry.chatType === "group" ||
        entry.chatType === "channel"
      ) {
        return {
          status: "granted",
          ...mintMemoryAudience(
            { kind: "conversation", agentId, sessionKey, sessionId },
            params.sessionKey,
            record,
          ),
        };
      }
      return deny("ineligible", `root session ${sessionKey} has no durable chat type`);
    }
    return deny("ineligible", `session lineage exceeds ${MAX_LINEAGE_HOPS} hops`);
  } catch (error) {
    releaseRecordLeases(record);
    // A caller that is no longer current propagates; unavailable session
    // storage denies memory access instead of failing the whole turn.
    assertCallerCurrent();
    return deny(
      "unverified",
      `session storage could not verify the lineage: ${formatErrorMessage(error)}`,
    );
  }
}

/** Return whether a memory audience was minted by this host process. */
export function isHostMemoryAudience(value: unknown): value is MemoryAudience {
  return typeof value === "object" && value !== null && hostAudiences.has(value);
}

/** Reject an audience presented outside its host-bound invocation session. */
export function assertMemoryAudienceSession(
  audience: MemoryAudience,
  sessionKey: string | undefined,
): void {
  if (!isHostMemoryAudience(audience)) {
    throw new Error("memory audience was not minted by this host");
  }
  if (audienceSessionKeys.get(audience) !== sessionKey) {
    throw new Error("memory audience is bound to a different session");
  }
}

/**
 * Bind a child audience to the child session's current incarnation and to the
 * parent's lineage, so a child reset or reassignment rejects it before provider I/O.
 * A detached child has no row; its grant binds that absence instead.
 */
export async function delegateMemoryAudience(
  audience: MemoryAudience,
  child: {
    sessionKey: string;
    storePath: string;
    detached?: boolean;
    assertCallerCurrent?: () => void;
  },
): Promise<MemoryAudienceGrant> {
  assertMemoryAudienceCurrent(audience);
  const parent = audienceRecords.get(audience)!;
  const { agentId } = audience;
  const assertCallerCurrent = child.assertCallerCurrent ?? (() => {});
  if (!isAgentSessionKey(child.sessionKey, agentId)) {
    throw new Error("memory audience delegation requires a session for the same agent");
  }
  const entry = await readEntryInWorker({
    agentId,
    sessionKey: child.sessionKey,
    storePath: child.storePath,
    assertCallerCurrent,
  });
  // Host-run children (for example recall sessions) use non-UUID session ids;
  // the lease below binds whatever exact incarnation the row holds.
  if (
    entry
      ? typeof entry.sessionId !== "string" || entry.sessionId.length === 0
      : child.detached !== true
  ) {
    throw new Error(
      `memory audience delegation requires an existing child session: ${child.sessionKey}`,
    );
  }
  const lease = await leaseSessionGeneration({
    agentId,
    sessionKey: child.sessionKey,
    storePath: child.storePath,
    entry,
  });
  if (!lease) {
    throw new Error(`child session changed during memory audience delegation: ${child.sessionKey}`);
  }
  const record: AudienceRecord = { parent, leases: [lease], state: "current", holders: 0 };
  try {
    // The parent can go stale while the child row is read; recheck both after the awaits.
    assertCallerCurrent();
    assertRecordCurrent(record);
  } catch (error) {
    releaseRecordLeases(record);
    throw error;
  }
  return mintMemoryAudience({ ...audience }, child.sessionKey, record);
}

/** Reject a retained audience after any captured session incarnation changes. */
export function assertMemoryAudienceCurrent(audience: MemoryAudience): void {
  const record = audienceRecords.get(audience);
  if (!record) {
    throw new Error("memory audience was not minted by this host");
  }
  assertRecordCurrent(record);
}

/**
 * Check a memory caller's whole authority: its own currency, its audience's
 * session binding and currency, and its abort signal. Final guards before
 * provider I/O or prompt publication use this, never the caller's check alone.
 */
export function assertMemoryCallerCurrent(context: MemoryCallerContext): void {
  context.assertCurrent();
  const { authority } = context;
  if (authority.kind === "session" && authority.audience) {
    assertMemoryAudienceSession(authority.audience, authority.sessionKey);
    assertMemoryAudienceCurrent(authority.audience);
  }
  context.signal?.throwIfAborted();
}
