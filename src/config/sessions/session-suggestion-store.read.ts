import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveExplicitIncognitoAgentSqliteTarget,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { listSessionSuggestionsInDatabase } from "./session-suggestion-store.kernel.js";
import { projectionLane } from "./session-transcript-worker-resources.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function listSessionSuggestions(
  input: SessionCollaborationScope,
  params: Parameters<typeof listSessionSuggestionsInDatabase>[2] = {},
) {
  const memory = getSessionActorStorageBinding(input);
  if (memory) {
    return memory.actor.storage!.read(
      { type: "session.suggestions.read", input: { params } },
      memory.authority,
    );
  }
  const source = input.incognito ? undefined : captureIncognitoSessionSource(input);
  if (source && "kind" in source) {
    return [];
  }
  const storePath = resolveSessionStorePathForScope(input);
  const agentId =
    parseAgentSessionKey(input.sessionKey)?.agentId ?? input.agentId ?? input.defaultAgentId;
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(storePath, {
    agentId,
    env: input.env,
  });
  const scope = {
    ...input,
    env: captureSessionTranscriptStorageEnvironment(explicit?.env ?? input.env ?? process.env),
  };
  const filters = { ...params };
  const incognito = scope.incognito ?? captureIncognitoSessionOperation(scope);
  if (incognito) {
    const { actor, authority } = incognito;
    if (actor.agentId !== agentId || actor.path !== storePath) {
      throw new Error("Suggestion target differs from its captured incognito actor");
    }
    const suggestions = await actor.sessions.sideData(
      authority,
      {
        type: "session.suggestions.read",
        input: { sessionKey: resolveSqliteSessionKey(scope.sessionKey, agentId), params: filters },
      },
      source?.admissionSignal,
    );
    authority.assertCurrent();
    actor.assertReadable();
    return suggestions;
  }
  if (agentId && isIncognitoOpenClawAgentSqlitePath(storePath, { agentId, env: scope.env })) {
    // Process-held databases retain their native owner until the incognito actor cutover.
    const database = getOpenIncognitoAgentDatabase(agentId, storePath);
    return database
      ? listSessionSuggestionsInDatabase(
          database,
          resolveSqliteSessionKey(scope.sessionKey, agentId),
          filters,
        )
      : [];
  }
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
