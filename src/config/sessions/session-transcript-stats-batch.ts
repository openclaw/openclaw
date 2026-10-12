import type {
  SessionTranscriptReadScope,
  SessionTranscriptStats,
} from "./session-accessor.sqlite-contract.js";
import { readTranscriptStatsBatchReadOnlySync } from "./session-accessor.sqlite-read.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "./session-entry-read-request.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { readTranscriptStatsAsync } from "./session-transcript-stats.js";

/** Preserve input order while reading each durable store in one worker request. */
export async function readTranscriptStatsBatchReadOnlyAsync(
  scopes: readonly SessionTranscriptReadScope[],
): Promise<Array<SessionTranscriptStats | null>> {
  const results: Array<SessionTranscriptStats | null> = scopes.map(() => null);
  const groups = new Map<
    string,
    {
      scope: SessionTranscriptReadScope & { storePath: string; env: NodeJS.ProcessEnv };
      sessionIds: string[];
      indexes: number[];
    }
  >();
  for (const [index, input] of scopes.entries()) {
    if (captureIncognitoSessionSource(input)) {
      results[index] = await readTranscriptStatsAsync(input);
      continue;
    }
    const { scope, agentId } = captureSessionEntryReadScope({
      ...input,
      sessionKey: input.sessionKey ?? "",
    });
    if (isNativeSessionEntryRead(scope, agentId)) {
      results[index] = readTranscriptStatsBatchReadOnlySync([input])[0] ?? null;
      continue;
    }
    const storePath = resolveSessionStorePathForScope(scope);
    const captured = { ...scope, agentId, storePath };
    const key = JSON.stringify([agentId, storePath, captured.env]);
    const group = groups.get(key) ?? { scope: captured, sessionIds: [], indexes: [] };
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
