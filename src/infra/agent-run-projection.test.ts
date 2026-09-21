import { expect, it } from "vitest";
import {
  buildAgentRunProjectionIndex,
  iterateProjectedAgentRunSessionKeys,
} from "./agent-run-projection.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

it("enumerates active session keys only for their encoded owner and current lifecycle", () => {
  const contexts: AgentRunContext[] = [
    { agentId: "MAIN", sessionKey: "agent:main:running", projectSessionActive: true },
    { agentId: "main", sessionKey: "agent:main:running", projectSessionActive: true },
    {
      agentId: "main",
      sessionKey: "agent:main:queued",
      projectSessionActive: true,
      capacityWaits: new Set([Symbol("queued")]),
    },
    {
      agentId: "main",
      sessionKey: "agent:main:capacity-wait",
      capacityWaits: new Set([Symbol("capacity-wait")]),
    },
    { agentId: "other", sessionKey: "agent:main:wrong-owner", projectSessionActive: true },
    { sessionKey: "ownerless", projectSessionActive: true },
    { agentId: "main", sessionKey: "unscoped", projectSessionActive: true },
    { agentId: "main", sessionId: "agent:main:id-only", projectSessionActive: true },
    { agentId: "main", sessionKey: "agent:main:hidden", projectSessionActive: false },
    {
      agentId: "main",
      sessionKey: "agent:main:previous-generation",
      projectSessionActive: true,
      lifecycleGeneration: "previous",
    },
  ];
  for (const context of contexts) {
    context.lifecycleGeneration ??= "current";
  }
  const index = buildAgentRunProjectionIndex({
    contexts,
    lifecycleGeneration: "current",
  });
  expect([...iterateProjectedAgentRunSessionKeys(index)]).toEqual([
    "agent:main:running",
    "agent:main:queued",
    "agent:main:capacity-wait",
  ]);
});
