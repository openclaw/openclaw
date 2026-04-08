import { normalizeAgentId } from "../routing/session-key.js";

const AUTOMATION_STATUS_SESSION_SUFFIX = "automation-status";

export function resolveAutomationStatusSessionKey(agentId?: string): string {
  return `agent:${normalizeAgentId(agentId)}:${AUTOMATION_STATUS_SESSION_SUFFIX}`;
}

export function isAutomationStatusSessionKey(sessionKey: string | undefined | null): boolean {
  const trimmed = sessionKey?.trim().toLowerCase();
  return Boolean(trimmed?.endsWith(`:${AUTOMATION_STATUS_SESSION_SUFFIX}`));
}
