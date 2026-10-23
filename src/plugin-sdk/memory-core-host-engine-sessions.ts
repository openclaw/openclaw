/** Private-local SDK subpath for memory session transcript helpers. */
import { isMainThread } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  buildSessionEntry as buildSessionEntryFromHost,
  listSessionTranscriptCorpusEntriesForAgent as listSessionTranscriptCorpusEntriesFromHost,
  readSessionResetRecallCutoff as readSessionResetRecallCutoffFromHost,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
import { assertBoundIncognitoMemorySyncAccess } from "../../packages/memory-host-sdk/src/host/openclaw-runtime-session.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { listSessionTranscriptInstancesInWorker } from "../config/sessions/session-history.js";
import {
  projectSessionMetadata,
  readMemorySessionTargets,
} from "../config/sessions/session-memory-targets.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export type SessionTranscriptChannelReadTarget = {
  key: string;
  agentId: string;
  expectedSessionId: string;
  storePath: string;
};

export type PreparedSessionTranscriptChannelRead = {
  withCurrentAccess: <T>(
    consume: (
      visible: readonly boolean[],
    ) => T & (T extends PromiseLike<unknown> ? never : unknown),
  ) => Promise<T>;
};

/** Retain exact transcript owners, then consume the complete disclosure batch synchronously. */
export async function prepareSessionTranscriptChannelRead(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  requesterSessionKey: string;
  sandboxed: boolean;
  groups: readonly (readonly SessionTranscriptChannelReadTarget[])[];
}): Promise<PreparedSessionTranscriptChannelRead> {
  if (!params.requesterSessionKey.trim()) {
    throw new Error("Session transcript disclosure requires a requesting session.");
  }
  const [
    { getInProcessGatewayToolContext },
    { getSessionRowProjection },
    rows,
    channel,
    visibility,
  ] = await Promise.all([
    import("../agents/tools/in-process-gateway.js"),
    import("../gateway/session-row-projection-access.js"),
    import("../gateway/session-row-prepared-read.js"),
    import("../agents/tools/sessions-channel-read-result.js"),
    import("./session-visibility.js"),
  ]);
  const projection = getSessionRowProjection(getInProcessGatewayToolContext());
  if (!projection) {
    return {
      withCurrentAccess: async (consume) => {
        const allowed = channel.currentSessionChannelReadAccess({
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
          sandboxed: params.sandboxed,
          a2aPolicy: visibility.createAgentToAgentPolicy(params.cfg),
          targets: params.groups.flat(),
        });
        let offset = 0;
        const result = consume(
          params.groups.map((group) => {
            const visible =
              group.length > 0 && allowed.slice(offset, offset + group.length).every(Boolean);
            offset += group.length;
            return visible;
          }),
        );
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new Error("Session transcript read consumers must remain synchronous");
        }
        return result;
      },
    };
  }
  const { bindSessionListRowRead, withCurrentSessionListRows } =
    await import("../gateway/session-list-read-result.js");
  const requester = { agentId: params.requesterAgentId, key: params.requesterSessionKey };
  return rows.withReadySessionRows<PreparedSessionTranscriptChannelRead>(
    projection,
    () => [requester, ...params.groups.flat()],
    (read) => {
      const requesterRow = read.describe(requester);
      if (!requesterRow) {
        throw new Error("The requesting session is no longer available.");
      }
      const requesterBinding = {};
      bindSessionListRowRead(requesterBinding, { projection, record: requesterRow });
      const groups = params.groups.map((targets) =>
        targets.map((target) => {
          const record = read.describe(target);
          if (
            !record ||
            record.entry.sessionId !== target.expectedSessionId ||
            record.entry.archivedAt !== undefined
          ) {
            return undefined;
          }
          const binding = {};
          bindSessionListRowRead(binding, { projection, record });
          return {
            binding,
            target: {
              agentId: record.agentId,
              key: record.key,
              storePath: record.storeTarget.storePath,
              expectedSessionId: record.entry.sessionId,
            },
          };
        }),
      );
      const captured = groups.flatMap((group) => group.flatMap((entry) => entry ?? []));
      return {
        withCurrentAccess: (consume) =>
          withCurrentSessionListRows(
            [requesterBinding, ...captured.map((entry) => entry.binding)],
            (current, currentRead) => {
              if (
                !currentRead ||
                getSessionRowProjection(getInProcessGatewayToolContext()) !== projection
              ) {
                throw new Error("Gateway changed while preparing transcript disclosure; retry.");
              }
              const channelAllowed = channel.currentSessionChannelReadAccess(
                {
                  requesterAgentId: params.requesterAgentId,
                  requesterSessionKey: params.requesterSessionKey,
                  sandboxed: params.sandboxed,
                  a2aPolicy: visibility.createAgentToAgentPolicy(currentRead.state.policyConfig),
                  targets: captured.map((entry) => entry.target),
                },
                currentRead,
              );
              const allowedByBinding = new Map(
                captured.map((entry, index) => [
                  entry.binding,
                  current[0] === true &&
                    current[index + 1] === true &&
                    channelAllowed[index] === true,
                ]),
              );
              const identity = (target: { key: string; agentId: string; storePath: string }) =>
                JSON.stringify([target.agentId, target.storePath, target.key]);
              return consume(
                groups.map((group) => {
                  if (group.length === 0 || group.some((entry) => !entry)) {
                    return false;
                  }
                  const aliases = new Set(
                    group.flatMap((entry) => (entry ? [identity(entry.target)] : [])),
                  );
                  return group.every(
                    (entry) =>
                      entry &&
                      allowedByBinding.get(entry.binding) === true &&
                      projection
                        .findBySessionId({
                          agentId: entry.target.agentId,
                          storePath: entry.target.storePath,
                          sessionId: entry.target.expectedSessionId,
                        })
                        .every((row) =>
                          aliases.has(
                            identity({
                              agentId: row.agentId,
                              key: row.key,
                              storePath: row.storeTarget.storePath,
                            }),
                          ),
                        ),
                  );
                }),
              );
            },
            true,
            [requester],
          ),
      };
    },
    { selection: { metadataOnly: true } },
  );
}

export type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

/** @deprecated Await loadArchivedSessionsAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function loadArchivedSessions(
  params: Parameters<typeof listSessionTranscriptArchivesReadOnly>[0],
) {
  warnPluginSdkDeprecation({
    family: "memory-session-sync-inventory",
    method: "loadArchivedSessions",
    replacement: "loadArchivedSessionsAsync",
  });
  assertBoundIncognitoMemorySyncAccess(params, "loadArchivedSessions", "loadArchivedSessionsAsync");
  return listSessionTranscriptArchivesReadOnly(params);
}
export {
  listSessionTranscriptArchivesInWorker as loadArchivedSessionsAsync,
  resolveMemorySessionTargetsInWorker as resolveMemorySessionTargetsAsync,
} from "../config/sessions/session-transcript-inventory-runtime.js";

export {
  buildSessionEntries,
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  matchesSessionEntryPrefixHash,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptStatsBatchReadOnlyAsync,
  readTranscriptStatsBatchReadOnlySync,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntry,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

// Internal actor sources are not part of the released plugin call signatures.
export const buildSessionEntry: (
  absPath: string,
  options?: Parameters<typeof buildSessionEntryFromHost>[1],
) => ReturnType<typeof buildSessionEntryFromHost> = buildSessionEntryFromHost;
export const listSessionTranscriptCorpusEntriesForAgent: (
  agentId: string,
  options?: Parameters<typeof listSessionTranscriptCorpusEntriesFromHost>[1],
) => ReturnType<typeof listSessionTranscriptCorpusEntriesFromHost> =
  listSessionTranscriptCorpusEntriesFromHost;
export const readSessionResetRecallCutoff: (
  scope: Parameters<typeof readSessionResetRecallCutoffFromHost>[0],
) => ReturnType<typeof readSessionResetRecallCutoffFromHost> = readSessionResetRecallCutoffFromHost;

export type {
  SessionFileEntry,
  SessionFileState,
  SessionTranscriptCorpusEntry,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

/** @deprecated Await loadMemorySessionMetadataAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): MemorySessionTarget | undefined {
  if (isMainThread) {
    warnPluginSdkDeprecation({
      family: "memory-session",
      method: "loadMemorySessionMetadata",
      replacement: "loadMemorySessionMetadataAsync",
    });
  }
  assertBoundIncognitoMemorySyncAccess(
    params,
    "loadMemorySessionMetadata",
    "loadMemorySessionMetadataAsync",
  );
  const instance = listSessionTranscriptInstances(params, {
    includeAllWindows: true,
    sessionId: params.sessionId,
  }).find(
    (candidate) =>
      candidate.agentId === normalizeAgentId(params.agentId) &&
      (!params.sessionKey || candidate.sessionKey === params.sessionKey),
  );
  return instance ? projectSessionMetadata(instance) : undefined;
}

/** Read the selected transcript's recorded source metadata through its owner. */
export async function loadMemorySessionMetadataAsync(
  params: Parameters<typeof loadMemorySessionMetadata>[0],
): Promise<MemorySessionTarget | undefined> {
  return (await loadMemorySessionMetadataBatchAsync({ ...params, sessions: [params] }))[0];
}

/** One history read resolves the complete ingestion batch. */
export async function loadMemorySessionMetadataBatchAsync(params: {
  agentId: string;
  storePath?: string;
  sessions: readonly { sessionId: string; sessionKey?: string }[];
}): Promise<MemorySessionTarget[]> {
  const selectors = new Map<string, Set<string | undefined>>();
  for (const { sessionId, sessionKey } of params.sessions) {
    const keys = selectors.get(sessionId) ?? new Set<string | undefined>();
    keys.add(sessionKey);
    selectors.set(sessionId, keys);
  }
  if (selectors.size === 0) {
    return [];
  }
  const agentId = normalizeAgentId(params.agentId);
  const scope = { agentId, storePath: params.storePath };
  const sessionIds = [...selectors.keys()];
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  const metadata = memory
    ? (await resolveMemorySessionTargetsInWorker({ ...scope, sessionIds })).filter(
        (entry) => entry.resolution === "live",
      )
    : (
        await listSessionTranscriptInstancesInWorker(
          { ...scope, projection: "list" },
          { includeAllWindows: true, sessionIds },
        )
      ).map((instance) => projectSessionMetadata(instance));
  return metadata.filter(
    (entry) =>
      entry.agentId === agentId &&
      (selectors.get(entry.sessionId)?.has(undefined) ||
        selectors.get(entry.sessionId)?.has(entry.sessionKey)),
  );
}

/** @deprecated Await resolveMemorySessionTargetsAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  warnPluginSdkDeprecation({
    family: "memory-session-sync-inventory",
    method: "resolveMemorySessionTargets",
    replacement: "resolveMemorySessionTargetsAsync",
  });
  assertBoundIncognitoMemorySyncAccess(
    params,
    "resolveMemorySessionTargets",
    "resolveMemorySessionTargetsAsync",
  );
  return readMemorySessionTargets(params);
}
