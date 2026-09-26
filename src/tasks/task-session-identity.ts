import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Retained rows with unresolved owners stay inaccessible without hiding other tasks. */
export function resolveTaskSessionAgentId(
  sessionKey: string | undefined,
  agentId?: string,
  cfg?: OpenClawConfig | (() => OpenClawConfig),
): string | undefined {
  const knownAgentId =
    normalizeOptionalString(agentId) ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (knownAgentId || !sessionKey || !cfg) {
    return knownAgentId;
  }
  try {
    return resolveSessionAgentId({ sessionKey, config: typeof cfg === "function" ? cfg() : cfg });
  } catch {
    return undefined;
  }
}

export async function resolveTaskSessionAgentIdAsync(
  sessionKey: string | undefined,
  agentId: string | undefined,
  readConfig: () => Promise<OpenClawConfig>,
): Promise<string | undefined> {
  const knownAgentId = resolveTaskSessionAgentId(sessionKey, agentId);
  if (knownAgentId || !sessionKey) {
    return knownAgentId;
  }
  try {
    const config = await readConfig();
    return resolveTaskSessionAgentId(sessionKey, agentId, config);
  } catch {
    return undefined;
  }
}

export function taskMatchesRelatedSession(
  task: TaskRecord,
  sessionKey: string | undefined,
  sessionAgentId?: string,
  cfg?: OpenClawConfig,
): boolean {
  if (!sessionKey) {
    return true;
  }
  return [
    { key: task.requesterSessionKey, agentId: task.requesterAgentId },
    { key: task.childSessionKey, agentId: task.agentId },
    // ownerKey belongs to the requester. task.agentId is the executor/child
    // candidate and must never adopt a colliding bare requester session.
    { key: task.ownerKey, agentId: task.requesterAgentId },
  ].some((candidate) => {
    if (normalizeOptionalString(candidate.key) !== sessionKey) {
      return false;
    }
    if (!sessionAgentId) {
      return true;
    }
    return resolveTaskSessionAgentId(candidate.key, candidate.agentId, cfg) === sessionAgentId;
  });
}
