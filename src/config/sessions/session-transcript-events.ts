import path from "node:path";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
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
  return withSessionTranscriptReadSource(captured, async (durableSource) => {
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
        return await readRestoredSessionTranscriptInWorker(
          { scope: captured, resolved: target, owner, assertCurrent },
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
  });
}
