import { expect, it } from "vitest";
import {
  buildAgentRunProjectionIndex,
  iterateProjectedAgentRunSessionKeys,
} from "./agent-run-projection.js";
import { resolveProjectedAgentRunProgressState } from "./agent-run-registry.js";
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

it("resolves progress across aliases and session IDs within the selected agent", () => {
  const wait = new Set([Symbol("wait")]);
  const contexts: AgentRunContext[] = [
    {
      agentId: "ops",
      sessionKey: "incident:AbC",
      projectSessionActive: true,
      capacityWaits: wait,
    },
    { agentId: "ops", sessionKey: "agent:ops:waiting", capacityWaits: wait },
    { agentId: "other", sessionKey: "incident:AbC", projectSessionActive: true },
    { agentId: "ops", sessionId: "running-id", projectSessionActive: true },
    { sessionKey: "legacy", projectSessionActive: true },
  ];
  const index = buildAgentRunProjectionIndex({
    contexts: contexts.map((context) => ({ ...context, lifecycleGeneration: "current" })),
    lifecycleGeneration: "current",
  });
  const state = (
    params: Omit<Parameters<typeof resolveProjectedAgentRunProgressState>[0], "index">,
  ) => resolveProjectedAgentRunProgressState({ ...params, index });

  expect(state({ sessionKeys: ["incident:AbC"], agentId: " OPS " })).toBe("queued");
  expect(state({ sessionKeys: ["incident:abc"], agentId: "ops" })).toBeUndefined();
  expect(state({ sessionKeys: ["incident:AbC"], defaultAgentId: "ops" })).toBe("queued");
  expect(state({ sessionKeys: ["incident:AbC"] })).toBeUndefined();
  expect(state({ sessionKeys: ["incident:AbC", "agent:other:any", "agent:ops:waiting"] })).toBe(
    "running",
  );
  expect(state({ sessionKeys: ["incident:AbC", "agent:ops:waiting", "agent:other:any"] })).toBe(
    "queued",
  );
  expect(
    state({ sessionKeys: ["agent:ops:waiting"], agentId: "", defaultAgentId: "ops" }),
  ).toBeUndefined();
  expect(state({ sessionKeys: ["agent:ops:waiting"] })).toBe("capacity-wait");
  expect(state({ sessionKeys: ["legacy"], agentId: "OPS", defaultAgentId: "ops" })).toBe("running");
  expect(
    state({ sessionKeys: ["legacy"], agentId: "other", defaultAgentId: "ops" }),
  ).toBeUndefined();
  for (const sessionKeys of [
    ["legacy", "agent:ops:waiting"],
    ["agent:ops:waiting", "legacy"],
  ]) {
    expect(state({ sessionKeys, defaultAgentId: "ops" })).toBe("running");
  }
  expect(state({ sessionKeys: ["agent:ops:waiting"], sessionId: "running-id" })).toBe("running");
  expect(state({ sessionKeys: [], sessionId: "running-id", agentId: "other" })).toBeUndefined();
});
