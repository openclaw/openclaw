import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { getRuntimeConfig } from "../config/io.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";

export function resolveHeartbeatFlag(runId: string, sourceRunId?: string, captured?: boolean) {
  const primary = getAgentRunContext(runId);
  const source = sourceRunId && sourceRunId !== runId ? getAgentRunContext(sourceRunId) : primary;
  if (primary?.isHeartbeat || source?.isHeartbeat) {
    return true;
  }
  // Captured source facts fill cleanup gaps; a live client heartbeat still wins.
  return source ? primary?.isHeartbeat : (captured ?? primary?.isHeartbeat);
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
export function shouldHideHeartbeatChatOutput(
  runId: string,
  sourceRunId?: string,
  captured?: boolean,
): boolean {
  if (!resolveHeartbeatFlag(runId, sourceRunId, captured)) {
    return false;
  }

  try {
    const cfg = getRuntimeConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

export function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
  isHeartbeat?: boolean;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId, params.isHeartbeat)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}
