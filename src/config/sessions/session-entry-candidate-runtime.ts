import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryCandidateAccessScope,
  ResolvedSessionEntryCandidateTarget,
} from "./session-accessor.types.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";

/** Resolve ordered candidates through the session owner without synchronous discovery. */
export async function resolveSessionEntryCandidateTargetForRuntime(
  scope: SessionEntryCandidateAccessScope,
): Promise<ResolvedSessionEntryCandidateTarget | null> {
  const candidates = uniqueStrings(scope.candidateKeys.map((key) => key.trim()).filter(Boolean));
  const sessionKey = candidates.find(isIncognitoSessionKey);
  const memory = sessionKey
    ? captureMemoryExactSessionReader({
        ...scope,
        sessionKey,
        agentId: resolveAgentIdFromSessionKey(sessionKey),
      })
    : undefined;
  const agentId = memory?.agentId ?? scope.agentId;
  const keys = candidates.map((candidateKey) => ({
    candidateKey,
    sessionKey: resolveSqliteSessionKey(candidateKey, agentId),
  }));
  const fallback = () => {
    const entry = scope.fallback;
    const fallbackKey = entry?.sessionKey.trim();
    return entry && fallbackKey
      ? {
          agentId,
          candidateKey: fallbackKey,
          entry: structuredClone(entry.entry),
          persisted: false,
          sessionKey: fallbackKey,
        }
      : null;
  };
  if (memory) {
    for (const key of keys) {
      if (!isIncognitoSessionKey(key.sessionKey)) {
        continue;
      }
      const entry = memory.read(key.sessionKey);
      if (entry) {
        return { agentId, ...key, entry, persisted: true };
      }
    }
    return fallback();
  }
  if (keys.length === 0) {
    return fallback();
  }
  const read = await readSessionEntriesFromStoreInWorker({
    agentId,
    env: scope.env,
    storePath: resolveSessionStorePathCore(scope.cfg.session?.store, {
      agentId,
      env: scope.env,
    }),
    sessionKeys: keys.map((key) => key.sessionKey),
    projection: "exact",
  });
  for (const key of keys) {
    const entry = read.entries.find((row) => row.sessionKey === key.sessionKey)?.entry;
    if (entry) {
      return { agentId, ...key, entry, persisted: true };
    }
  }
  return fallback();
}
