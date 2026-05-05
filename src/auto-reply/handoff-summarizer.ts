import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export interface HandoffSnapshot {
  summary: string;
  activeSubagents: Array<{
    sessionId: string;
    role?: string;
    lastStatus?: string;
  }>;
}

/**
 * Constructs a leader-subordinate hierarchy enforcement message.
 * This is injected into the first turn of a fallback model.
 */
export function buildHierarchyReinforcementMessage(snapshot: HandoffSnapshot): AgentMessage {
  const subagentReport = snapshot.activeSubagents
    .map((s) => `- Subagent ${s.sessionId} (${s.role ?? "leaf"}): ${s.lastStatus ?? "running"}`)
    .join("\n");

  const content = [
    "⚠️ SYSTEM HANDOFF: PREVIOUS MODEL EXHAUSTED QUOTA ⚠️",
    "You are the new LEADER (Orchestrator). Do not perform tasks assigned to subordinates.",
    "",
    "ACTIVE SUBORDINATE UNITS:",
    subagentReport || "None active.",
    "",
    "CURRENT STATE SUMMARY:",
    snapshot.summary,
    "",
    "INSTRUCTIONS:",
    "1. Review the state and subordinate reports.",
    "2. Provide strategic guidance and commands to subordinates.",
    "3. DO NOT repeat code or work already performed by subordinates.",
  ].join("\n");

  return {
    role: "assistant",
    content: content,
    // @ts-ignore - Internal metadata for routing and enforcement
    metadata: {
      kind: "subordinate_report",
      enforce_role: "observer_only",
      is_handoff: true,
    },
  };
}
