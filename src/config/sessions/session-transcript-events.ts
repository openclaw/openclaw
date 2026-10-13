import path from "node:path";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import {
  readIncognitoSessionHistory,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Load durable raw events through the existing full-transcript hydration owner. */
export async function loadSessionTranscriptEvents(
  scope: SessionTranscriptReadScope,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
): Promise<TranscriptEvent[]> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      memory.assertCurrent();
      return [];
    }
    const result = await memory.read("session.history.hydrate", {
      maxEventBytes: scope.maxEventBytes,
    });
    if (result.kind !== "full") {
      throw new Error("Transcript events received a bounded hydration result");
    }
    return result.snapshot.events;
  }
  const source = suppliedIncognito ? undefined : captureIncognitoSessionSource(scope);
  if (source && "kind" in source) {
    source.assertCurrent();
    return [];
  }
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    const result = await readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.hydrate",
      input: { ...target, maxEventBytes: scope.maxEventBytes },
    }));
    if (result.kind !== "full") {
      throw new Error("Transcript events received a bounded hydration result");
    }
    return result.snapshot.events;
  }
  const captured = {
    agentId: scope.agentId,
    clone: scope.clone,
    defaultAgentId: scope.defaultAgentId,
    hydrateSkillPromptRefs: scope.hydrateSkillPromptRefs,
    readConsistency: scope.readConsistency,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    sessionFile: scope.sessionFile,
    threadId: scope.threadId,
    maxEventBytes: scope.maxEventBytes,
    sessionEntry: scope.sessionEntry ? { sessionId: scope.sessionEntry.sessionId } : undefined,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  } satisfies SessionTranscriptReadScope;
  if (
    isIncognitoSessionKey(captured.sessionKey) ||
    (captured.storePath &&
      isIncognitoOpenClawAgentSqlitePath(captured.storePath, {
        agentId: normalizeAgentId(
          captured.agentId ??
            parseAgentSessionKey(captured.sessionKey)?.agentId ??
            captured.defaultAgentId,
        ),
        env: captured.env,
      }))
  ) {
    // Incognito SQLite stays with its process-held owner until the actor cutover.
    return readRestoredSessionTranscript(captured, () => loadTranscriptEventsSync(captured));
  }
  return withSessionTranscriptReadSource(
    captured,
    (native) => readRestoredSessionTranscript(native, () => loadTranscriptEventsSync(native)),
    async (durableSource) => {
      const { resolved: target, expectedIdentity: identity } = durableSource;
      if (!identity) {
        return [];
      }
      const options = toDatabaseOptions(target);
      const receipt = resolveSessionTranscriptReadFence(target);
      const admission = receipt ? { ...receipt } : undefined;
      const read = async (owner: SessionHistoryWorkerDatabase) => {
        const assertCurrent = () => {
          durableSource.assertCurrent();
          owner.assertCurrent();
        };
        try {
          return await readRestoredSessionTranscript(
            captured,
            async () => {
              const result = await owner.readTranscript({
                target: captured,
                resolvedScope: target,
                admission,
                expectedIdentity: identity,
              });
              assertCurrent();
              if (result.kind !== "full") {
                throw new Error("Transcript events received a bounded hydration result");
              }
              return result.snapshot.events;
            },
            {
              assertCurrent,
              coldRead: {
                target,
                readMetadata: async () => {
                  const metadata = await owner.readColdMetadata({
                    sessionId: target.sessionId,
                    env: captured.env,
                  });
                  assertCurrent();
                  return metadata.archive;
                },
              },
            },
          );
        } finally {
          assertCurrent();
        }
      };
      return (
        runLockedSessionTranscriptRead(options, () =>
          withSessionHistoryWorkerDatabase(options, read, targetDiscoveryLane),
        ) ?? read(durableSource.owner)
      );
    },
  );
}
