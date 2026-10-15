import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { listSessionSuggestionsInDatabase } from "./session-suggestion-store.kernel.js";
import { projectionLane } from "./session-transcript-worker-resources.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function listSessionSuggestions(
  input: SessionCollaborationScope,
  params: Parameters<typeof listSessionSuggestionsInDatabase>[2] = {},
) {
  const memory = captureSessionActorStorageOwner(input, { assertCurrent() {}, authorize() {} });
  if (memory) {
    const query = {
      type: "session.suggestions.read" as const,
      input: { params: structuredClone(params) },
    };
    return (
      (await withSessionActorStorage(
        input,
        {
          authority: memory.authority,
          lifetime: {
            assertCurrent: () => memory.authority.assertCurrent(),
            assertReadable: () => memory.authority.assertCurrent(),
          },
        },
        (binding) => binding.actor.storage.read(query, binding.authority),
      )) ?? []
    );
  }
  const storePath = resolveSessionStorePathForScope(input);
  const scope = {
    ...input,
    env: captureSessionTranscriptStorageEnvironment(input.env ?? process.env),
  };
  const filters = { ...params };
  return withSessionStoreReaderInWorker(
    { ...scope, storePath },
    ({ reader, logicalAgentId }) =>
      reader.readSuggestions({
        sessionKey: resolveSqliteSessionKey(scope.sessionKey, logicalAgentId),
        params: filters,
        env: scope.env,
      }),
    { dataOnly: true, lane: projectionLane },
  );
}
