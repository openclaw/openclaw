import { isDeepStrictEqual } from "node:util";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { assertSessionEntryCohortScope } from "../../config/sessions/session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewaySessionEntryReadPlan } from "../../gateway/session-utils-store-worker.js";
import type { GatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store.types.js";

export type CapturedReplyToolAuthoritySession = {
  storePath: string;
  canonicalKey: string;
  storeKeys: readonly string[];
  agentId: string;
  source: CapturedSessionEntryReadSource | undefined;
  sources: readonly CapturedSessionEntryReadSource[] | undefined;
  sessionId: string | undefined;
  lifecycleRevision: SessionEntry["lifecycleRevision"];
};

export function captureReplyToolAuthoritySession(
  loaded: GatewaySessionStoreTargetWithStore & { entry?: SessionEntry },
): CapturedReplyToolAuthoritySession {
  return {
    storePath: loaded.storePath,
    canonicalKey: loaded.canonicalKey,
    storeKeys: [...loaded.storeKeys],
    agentId: loaded.agentId,
    source: loaded.capturedReadSource,
    sources: loaded.capturedReadSources,
    sessionId: loaded.entry?.sessionId,
    lifecycleRevision: loaded.entry?.lifecycleRevision,
  };
}

const actorComparisonOptions = { skipPrototype: true };

/** Retain the captured file-backed classification while its published entry remains current. */
export function retainReplyToolAuthorityClassification(
  original: CapturedReplyToolAuthoritySession | undefined,
  entry: SessionEntry | undefined,
  assertCurrent: () => void,
) {
  if (!original?.source || typeof original.source.databaseIdentity !== "string") {
    return undefined;
  }
  const predicate = retainPreparedSessionEntryPredicate({
    databaseIdentity: `file:${original.source.databaseIdentity}`,
    sessionKey: original.canonicalKey,
    entry,
    matches: (before, after) =>
      before?.sessionId === after?.sessionId &&
      before?.lifecycleRevision === after?.lifecycleRevision &&
      before?.sandbox === after?.sandbox &&
      before?.sandboxMode === after?.sandboxMode &&
      // Admitted actor data is structural: key order/prototypes do not identify a creator.
      isDeepStrictEqual(before?.createdActor, after?.createdActor, actorComparisonOptions),
  });
  return {
    release: () => predicate.release(),
    assertCurrent: () => {
      assertCurrent();
      if (!predicate.isCurrent()) {
        const reason = predicate.canRefresh()
          ? "entry predicate pending or unknown"
          : "entry predicate changed or released";
        throw new Error(`Tool authority classification session changed (${reason})`);
      }
    },
  };
}

/** Refresh classification on the admitted owner without changing the independent caller plan. */
export async function withReplyToolAuthorityCohort<T>(params: {
  reader?: SessionEntryCohortReader;
  original?: CapturedReplyToolAuthoritySession;
  readPlan?: GatewaySessionEntryReadPlan;
  env: NodeJS.ProcessEnv;
  assertCurrent(): void;
  prepare(): Promise<T>;
  consume(entry: SessionEntry | undefined): Promise<T>;
}): Promise<T> {
  const { reader, original, readPlan } = params;
  reader?.assertCurrent();
  // Initial preparation also owns the independent question caller's read plan.
  if (
    !reader ||
    !original ||
    !readPlan ||
    !original.source ||
    original.sources?.length !== 1 ||
    original.storeKeys.length !== 1 ||
    original.storeKeys[0] !== original.canonicalKey ||
    original.canonicalKey !== reader.sessionKey ||
    original.agentId !== reader.logicalAgentId ||
    original.source.path !== reader.database.path
  ) {
    const value = await params.prepare();
    reader?.assertCurrent();
    return value;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    readPlan.assertCurrent();
    reader.assertCurrent();
  };
  const key = assertSessionEntryCohortScope(reader, {
    agentId: original.agentId,
    storePath: original.source.path,
    sessionKey: original.canonicalKey,
    env: params.env,
  });
  const preparedEntry = await reader.withRead(
    { sessionKeys: [key], snapshotFields: [] },
    assertCurrent,
    (read, assertPrepared) => {
      assertPrepared();
      const entry = read.entries.find((row) => row.sessionKey === key)?.entry;
      if (
        !isDeepStrictEqual(read.source, original.source) ||
        entry?.sessionId !== original.sessionId ||
        entry?.lifecycleRevision !== original.lifecycleRevision
      ) {
        throw new Error("Tool authority classification source changed");
      }
      return entry;
    },
  );
  const value = await params.consume(preparedEntry);
  assertCurrent();
  return value;
}
