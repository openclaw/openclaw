import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

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

export function resolveSessionKeyForTranscriptFile(sessionFile: string): string | undefined {
  const targetPath = resolveTranscriptPathForComparison(sessionFile);
  if (!targetPath) {
    return undefined;
  }
  const cfg = loadConfig();
  const { store } = loadCombinedSessionStoreForGateway(cfg);
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key,
      scanLegacyKeys: false,
      store,
    });
    const sessionAgentId = normalizeAgentId(target.agentId);
    const matches = resolveSessionTranscriptCandidates(
      entry.sessionId,
      target.storePath,
      entry.sessionFile,
      sessionAgentId,
    ).some((candidate) => resolveTranscriptPathForComparison(candidate) === targetPath);
    if (matches) {
      return key;
    }
  }
  return undefined;
}
