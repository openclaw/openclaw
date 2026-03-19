import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const TRANSCRIPT_SESSION_KEY_CACHE = new Map<string, string>();

function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sessionKeyMatchesTranscriptPath(params: {
  cfg: ReturnType<typeof loadConfig>;
  store: Record<string, SessionEntry>;
  key: string;
  targetPath: string;
}): boolean {
  const entry = params.store[params.key];
  if (!entry?.sessionId) {
    return false;
  }
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    scanLegacyKeys: false,
    store: params.store,
  });
  const sessionAgentId = normalizeAgentId(target.agentId);
  return resolveSessionTranscriptCandidates(
    entry.sessionId,
    target.storePath,
    entry.sessionFile,
    sessionAgentId,
  ).some((candidate) => resolveTranscriptPathForComparison(candidate) === params.targetPath);
}

export function clearSessionTranscriptKeyCacheForTests(): void {
  TRANSCRIPT_SESSION_KEY_CACHE.clear();
}

export function resolveSessionKeyForTranscriptFile(sessionFile: string): string | undefined {
  const targetPath = resolveTranscriptPathForComparison(sessionFile);
  if (!targetPath) {
    return undefined;
  }
  const cfg = loadConfig();
  const { store } = loadCombinedSessionStoreForGateway(cfg);

  const cachedKey = TRANSCRIPT_SESSION_KEY_CACHE.get(targetPath);
  if (
    cachedKey &&
    sessionKeyMatchesTranscriptPath({
      cfg,
      store,
      key: cachedKey,
      targetPath,
    })
  ) {
    return cachedKey;
  }

  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId || key === cachedKey) {
      continue;
    }
    if (
      sessionKeyMatchesTranscriptPath({
        cfg,
        store,
        key,
        targetPath,
      })
    ) {
      TRANSCRIPT_SESSION_KEY_CACHE.set(targetPath, key);
      return key;
    }
  }

  TRANSCRIPT_SESSION_KEY_CACHE.delete(targetPath);
  return undefined;
}
