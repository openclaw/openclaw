import { isDeepStrictEqual } from "node:util";
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

/** Initial selection can supply classification only when one exact durable source won. */
export function selectReplyToolAuthorityEntry(
  target: GatewaySessionStoreTargetWithStore,
  key: string,
) {
  const entry = target.store[target.canonicalKey];
  return entry &&
    !entry.incognito &&
    target.canonicalKey === key &&
    target.storeKeys.length === 1 &&
    target.storeKeys[0] === key &&
    target.capturedReadSources?.length === 1 &&
    typeof target.capturedReadSource?.databaseIdentity === "string"
    ? entry
    : undefined;
}

/** Refresh classification on the admitted owner without changing the independent caller plan. */
export async function withReplyToolAuthorityCohort<T>(params: {
  reader?: SessionEntryCohortReader;
  original?: CapturedReplyToolAuthoritySession;
  readPlan?: GatewaySessionEntryReadPlan;
  env: NodeJS.ProcessEnv;
  assertCurrent(): void;
  prepare(): Promise<T>;
  consume(entry: SessionEntry | undefined): T;
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
  return reader.withRead(
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
      const value = params.consume(entry);
      assertPrepared();
      return value;
    },
  );
}
