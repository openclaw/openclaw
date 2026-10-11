import path from "node:path";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Load durable raw events through the existing full-transcript hydration owner. */
export async function loadTranscriptEvents(
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
  const storePath =
    captured.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteTranscriptReadScope(captured)));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const target = await prepareSqliteTranscriptReadScope(captured);
    assertStateCurrent();
    discovery.assertCurrent();
    const options = toDatabaseOptions(target);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    const identity = identities.get(assertSessionStoreReadCandidate(databasePath, candidates));
    if (!identity) {
      // Discovery can select an absent member of the captured sibling family.
      if (!readDatabasePathIdentitySync(databasePath).key.startsWith("file:")) {
        return [];
      }
      throw new Error("Transcript events changed their captured database owner");
    }
    const assertSourceCurrent = () => {
      assertStateCurrent();
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(databasePath, candidates);
      const current = readDatabasePathIdentitySync(databasePath);
      if (current.key !== identity.key || current.birthtime !== identity.birthtime) {
        throw new Error("Transcript events changed their captured database owner");
      }
    };
    assertSourceCurrent();
    if (!identity.key.startsWith("file:")) {
      return [];
    }
    target.path = databasePath;
    const receipt = resolveSessionTranscriptReadFence(target);
    const admission = receipt ? { ...receipt } : undefined;
    const read = async (owner: SessionHistoryWorkerDatabase) => {
      const assertCurrent = () => {
        assertSourceCurrent();
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
      ) ?? withSessionHistoryWorkerDatabase(options, read)
    );
  });
}
