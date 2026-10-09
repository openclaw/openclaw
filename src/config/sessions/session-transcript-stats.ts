import { randomUUID } from "node:crypto";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptStatsSync } from "./session-accessor.sqlite-read.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import { readIncognitoSessionHistory } from "./session-incognito-history-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import type { SessionTranscriptStatsOperations } from "./session-transcript-stats.worker.js";

/** Read hot and cold statistics through the captured database's existing executor. */
export function readTranscriptStatsAsync(scope: SessionTranscriptReadScope) {
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.stats",
      input: target,
    }));
  }
  return withSessionTranscriptReadSource(
    scope,
    readTranscriptStatsSync,
    ({ scope: captured, resolved, expectedIdentity, assertCurrent }) =>
      withSessionEntryWorker(
        { ...toDatabaseOptions(resolved), path: captured.storePath },
        expectedIdentity?.key.slice("file:".length),
        assertCurrent,
        async (execution, source) => {
          const result = await execution.runExisting(source, (worker) =>
            executeOpenClawAgentWorkerPublication<SessionTranscriptStatsOperations, "read">(
              worker,
              {
                id: randomUUID(),
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptStats)
                  .href,
                input: undefined,
                command: { type: "read", input: { sessionId: resolved.sessionId } },
              },
            ),
          );
          assertCurrent();
          return result ?? { eventCount: 0, maxSeq: 0, sizeBytes: 0 };
        },
      ),
  );
}
