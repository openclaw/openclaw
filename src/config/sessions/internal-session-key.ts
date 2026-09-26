import crypto from "node:crypto";
import { normalizeAgentId } from "../../routing/session-key.js";

const INTERNAL_SESSION_EFFECTS_SEGMENT = "internal-session-effects";
const INTERNAL_SESSION_EFFECTS_REST_PREFIX = `${INTERNAL_SESSION_EFFECTS_SEGMENT}:`;

function normalizeInternalRunId(runId: string): string {
  const readable = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "run";
  const digest = crypto.createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

/** Resolves the hidden SQLite session identity owned by one internal-effects run. */
export function resolveInternalSessionEffectsIdentity(params: {
  agentId: string;
  incognito?: boolean;
  runId: string;
}): {
  sessionId: string;
  sessionKey: string;
} {
  const suffix = normalizeInternalRunId(params.runId);
  const keySuffix = params.incognito
    ? `incognito-${suffix}`
    : suffix.startsWith("incognito-")
      ? `legacy-${suffix}`
      : suffix;
  return {
    sessionId: `${INTERNAL_SESSION_EFFECTS_SEGMENT}-${suffix}`,
    sessionKey: `agent:${normalizeAgentId(params.agentId)}:${INTERNAL_SESSION_EFFECTS_SEGMENT}:${keySuffix}`,
  };
}

/** Returns true for SQLite entries that exist only to contain suppressed run effects. */
export function isInternalSessionEffectsKey(sessionKey: string): boolean {
  if (!sessionKey.startsWith("agent:")) {
    return false;
  }
  const agentEnd = sessionKey.indexOf(":", 6);
  return agentEnd >= 0 && sessionKey.startsWith(INTERNAL_SESSION_EFFECTS_REST_PREFIX, agentEnd + 1);
}
