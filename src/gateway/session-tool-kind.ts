import { buildAgentMainSessionKey, parseAgentSessionKey } from "../routing/session-key.js";

export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  const parsedAgent = parseAgentSessionKey(key);
  if (parsedAgent) {
    const canonicalMain = buildAgentMainSessionKey({
      agentId: parsedAgent.agentId,
      mainKey: params.mainKey,
    });
    if (key === canonicalMain) {
      return "main";
    }
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "other";
}
