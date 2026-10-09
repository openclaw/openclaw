import {
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { resolveVoiceWakeRouteByTrigger } from "../infra/voicewake-routing.js";
import { classifySessionKeyShape } from "../routing/session-key.js";
import { loadSessionEntry } from "./session-utils.js";

/** Keep wake forwarding and wake-started Talk on the same Gateway-owned route. */
export function resolveVoiceWakeSessionTarget(params: {
  route: ReturnType<typeof resolveVoiceWakeRouteByTrigger>;
  cfg: OpenClawConfig;
  knownAgents: readonly string[];
  trigger: string;
  warn: (message: string) => void;
}): { agentId: string; sessionKey: string } | undefined {
  const { route, cfg, knownAgents, trigger, warn } = params;
  if ("agentId" in route) {
    if (!knownAgents.includes(route.agentId)) {
      warn(`voicewake routing ignored unknown agentId="${route.agentId}" trigger="${trigger}"`);
      return undefined;
    }
    const sessionKey = resolveExplicitAgentSessionKey({ cfg, agentId: route.agentId });
    return sessionKey ? { agentId: route.agentId, sessionKey } : undefined;
  }
  if ("sessionKey" in route) {
    if (classifySessionKeyShape(route.sessionKey) === "malformed_agent") {
      warn(
        `voicewake routing ignored malformed sessionKey="${route.sessionKey}" trigger="${trigger}"`,
      );
      return undefined;
    }
    const canonicalKey = loadSessionEntry(route.sessionKey, {
      clone: false,
      projection: "list",
    }).canonicalKey;
    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    if (!knownAgents.includes(agentId)) {
      warn(
        `voicewake routing ignored unknown session agent="${agentId}" sessionKey="${canonicalKey}" trigger="${trigger}"`,
      );
      return undefined;
    }
    return { agentId, sessionKey: canonicalKey };
  }
  return undefined;
}
