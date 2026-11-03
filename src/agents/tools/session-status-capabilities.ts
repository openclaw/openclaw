/**
 * Session capability summary for `session_status`.
 *
 * The Gateway's `tools.effective` owner decides which tools a session exposes and why the
 * rest are missing; this module only asks it and renders the answer for the model, so an
 * absent tool reads as a session limit rather than a product limit.
 */
import type { EffectiveToolInventoryResult } from "../tools-effective-inventory.types.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export type SessionCapabilities = {
  checked: "live-session" | "local-config" | "unavailable";
  available: string[];
  unavailable: Array<{ reason: string; tools: string[] }>;
  notices?: string[];
  error?: string;
};

function summarizeSessionCapabilities(
  inventory: EffectiveToolInventoryResult,
): SessionCapabilities {
  const access = inventory.toolAccess;
  const available = new Set(
    inventory.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
  );
  const byReason = new Map<string, string[]>();
  for (const tool of access?.tools ?? []) {
    if (tool.status === "available" || tool.status === "allowed") {
      available.add(tool.id);
      continue;
    }
    if (available.has(tool.id)) {
      continue;
    }
    const reason = tool.reasons.map((entry) => entry.label).join("; ") || "Not loaded";
    byReason.set(reason, [...(byReason.get(reason) ?? []), tool.id]);
  }
  const notices = inventory.notices?.map((notice) => notice.message);
  return {
    checked: access?.checked ?? "live-session",
    available: [...available].toSorted(),
    unavailable: [...byReason]
      .map(([reason, tools]) => ({ reason, tools: tools.toSorted() }))
      .toSorted((a, b) => a.reason.localeCompare(b.reason)),
    ...(notices?.length ? { notices } : {}),
  };
}

export async function resolveSessionCapabilities(params: {
  callGateway: AgentToolGatewayRequestCaller;
  agentId: string;
  sessionKey: string;
}): Promise<SessionCapabilities> {
  try {
    const inventory = await params.callGateway<EffectiveToolInventoryResult>({
      method: "tools.effective",
      params: { agentId: params.agentId, sessionKey: params.sessionKey },
    });
    return summarizeSessionCapabilities(inventory);
  } catch (error) {
    // Status stays useful without the inventory; the model sees that the check failed.
    return {
      checked: "unavailable",
      available: [],
      unavailable: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatSessionCapabilities(capabilities: SessionCapabilities): string {
  if (capabilities.checked === "unavailable") {
    return `Capabilities: could not be checked (${capabilities.error ?? "unknown error"}). This is not evidence that OpenClaw lacks a capability.`;
  }
  return [
    "Capabilities (this session only; other sessions, agents, or config can differ):",
    `Available tools: ${capabilities.available.join(", ") || "none"}`,
    ...(capabilities.unavailable.length
      ? [
          "Not available in this session:",
          ...capabilities.unavailable.map(
            (entry) => `- ${entry.reason}: ${entry.tools.join(", ")}`,
          ),
        ]
      : []),
    ...(capabilities.notices?.length
      ? ["Notices:", ...capabilities.notices.map((notice) => `- ${notice}`)]
      : []),
  ].join("\n");
}
