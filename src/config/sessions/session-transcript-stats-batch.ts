import type {
  SessionTranscriptReadScope,
  SessionTranscriptStats,
} from "./session-accessor.sqlite-contract.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionStoreWorkerReadInput } from "./session-entry-read-runtime.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";

type TranscriptStatsBatch = {
  scope: SessionStoreWorkerReadInput & { env: NodeJS.ProcessEnv };
  sessionIds: string[];
  indexes: number[];
};

/** Preserve input order while reading each durable store in one worker request. */
export async function readTranscriptStatsBatchReadOnlyAsync(
  scopes: readonly SessionTranscriptReadScope[],
): Promise<Array<SessionTranscriptStats | null>> {
  const results: Array<SessionTranscriptStats | null> = scopes.map(() => null);
  const groups = new Map<string, TranscriptStatsBatch>();
  for (const [index, input] of scopes.entries()) {
    const memory = captureSessionActorTranscriptRead(input);
    if (memory) {
      if (memory.missing) {
        memory.assertCurrent();
        results[index] = { eventCount: 0, maxSeq: 0, sizeBytes: 0 };
      } else {
        results[index] = await memory.read("session.history.stats", {});
      }
      continue;
    }
    const { scope, agentId } = captureSessionEntryReadScope({
      ...input,
      sessionKey: input.sessionKey ?? "",
    });
    const storePath = resolveSessionStorePathForScope(scope);
    const captured = { ...scope, agentId, storePath };
    const key = JSON.stringify([agentId, storePath, captured.env]);
    const group: TranscriptStatsBatch = groups.get(key) ?? {
      scope: captured,
      sessionIds: [],
      indexes: [],
    };
    group.sessionIds.push(input.sessionId);
    group.indexes.push(index);
    groups.set(key, group);
  }
  await Promise.all(
    [...groups.values()].map(async ({ scope, sessionIds, indexes }) => {
      const stats = await withSessionStoreReaderInWorker(
        scope,
        ({ reader, database }) =>
          reader.readTranscriptStatsBatch({
            sessionIds,
            env: database.env ?? scope.env,
          }),
        { backing: true, dataOnly: true },
      );
      for (const [offset, index] of indexes.entries()) {
        results[index] = stats[offset] ?? null;
      }
    }),
  );
  return results;
}
