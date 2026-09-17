import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { SystemEventSourceGeneration } from "./system-events.js";

export function isSourceGenerationCurrent(
  expected: SystemEventSourceGeneration | undefined,
  expectedAgentId?: string,
): boolean {
  if (!expected) {
    return true;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(expected.sessionKey, expectedAgentId);
    if (expectedAgentId && agentId !== expectedAgentId) {
      return false;
    }
    const storePath = resolveSessionStorePathCore(expected.sessionStore, { agentId });
    const current = loadExactSessionEntryReadOnly({
      agentId,
      storePath,
      sessionKey: expected.sessionKey,
      clone: false,
    })?.entry;
    return (
      current?.sessionId === expected.sessionId &&
      current.lifecycleRevision === expected.lifecycleRevision
    );
  } catch {
    return false;
  }
}

export function assertSourceGenerationCurrent(
  expected: SystemEventSourceGeneration | undefined,
  expectedAgentId?: string,
): void {
  if (!isSourceGenerationCurrent(expected, expectedAgentId)) {
    throw new Error("source session generation is no longer current");
  }
}
