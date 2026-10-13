import type {
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { IncognitoSessionHistoryBinding } from "./session-incognito-history-read.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Explicit actor acquisition; ordinary Memory discovery continues to use its host owner. */
export function readIncognitoMemoryCorpus(
  binding: IncognitoSessionHistoryBinding,
  scope: SessionTranscriptCorpusScope,
  options: SessionTranscriptCorpusOptions,
  signal?: AbortSignal,
  onRead?: (assertCurrent: () => void) => void,
) {
  const { actor, authority } = binding;
  const target = structuredClone(binding.target);
  const captured = structuredClone({
    scope: { ...scope, env: captureSessionTranscriptStorageEnvironment(scope.env) },
    options,
  });
  if (scope.normalizedAgentId !== actor.agentId) {
    throw new Error("Incognito Memory corpus belongs to another agent");
  }
  captured.scope.storePath = actor.path;
  captured.scope.artifactDirs = [];
  captured.scope.isSharedFixedStore = false;
  const claims = new Map(
    actor.sessions
      .deadlines()
      .map(({ sessionKey }) => [sessionKey, actor.sessions.captureCurrent(sessionKey)]),
  );
  const snapshots = new Map<string, ReturnType<typeof actor.sessions.captureSnapshot>>();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    authority.assertCurrent();
    const currentKeys = actor.sessions.deadlines().map(({ sessionKey }) => sessionKey);
    if (currentKeys.length !== claims.size || currentKeys.some((key) => !claims.has(key))) {
      throw new Error("Incognito Memory corpus changed during preparation");
    }
    for (const [key, claim] of claims) {
      claim.authorize(authority, "commit");
      snapshots.get(key)?.assertCurrent();
    }
    actor.assertReadable();
  };
  assertCurrent();
  const result = actor.sessions.withSharedState(async () => {
    const entries = await actor.sessions.history(
      { assertCurrent, authorize: (stage, facts) => authority.authorize?.(stage, facts) },
      {
        type: "session.history.memory-corpus",
        input: { ...target, ...captured, sessionKeys: [...claims.keys()] },
      },
      signal,
      (rows) => {
        assertCurrent();
        for (const row of rows) {
          if (!row.sessionKey || !claims.has(row.sessionKey)) {
            throw new Error("Incognito Memory corpus returned an uncaptured session");
          }
        }
        for (const key of claims.keys()) {
          snapshots.set(key, actor.sessions.captureSnapshot(key));
        }
        onRead?.(assertCurrent);
      },
    );
    assertCurrent();
    return entries;
  });
  return result.then((entries) => {
    assertCurrent();
    return entries;
  });
}
