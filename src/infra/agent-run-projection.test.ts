import { expect, it, vi } from "vitest";
import {
  buildAgentRunProjectionIndex,
  iterateProjectedAgentRunSessionKeys,
} from "./agent-run-projection.js";
import {
  prepareProjectedAgentRunProgressState,
  resolveProjectedAgentRunProgressState,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

function projection(contexts: AgentRunContext[]) {
  return buildAgentRunProjectionIndex({
    contexts: contexts.map((context) => ({ lifecycleGeneration: "current", ...context })),
    lifecycleGeneration: "current",
  });
}
const active = { agentId: "main", projectSessionActive: true };
const capacityWaits = new Set([Symbol("wait")]);

it("enumerates active session keys only for their encoded owner and current lifecycle", () => {
  const index = projection([
    { ...active, agentId: "MAIN", sessionKey: "agent:main:running" },
    { ...active, sessionKey: "agent:main:running" },
    { ...active, sessionKey: "agent:main:queued", capacityWaits },
    { agentId: "main", sessionKey: "agent:main:capacity-wait", capacityWaits },
    { ...active, agentId: "other", sessionKey: "agent:main:wrong-owner" },
    { sessionKey: "ownerless", projectSessionActive: true },
    { ...active, sessionKey: "unscoped" },
    { ...active, sessionId: "agent:main:id-only" },
    { ...active, sessionKey: "agent:main:hidden", projectSessionActive: false },
    { ...active, sessionKey: "agent:main:previous", lifecycleGeneration: "previous" },
  ]);
  expect([...iterateProjectedAgentRunSessionKeys(index)]).toEqual([
    "agent:main:running",
    "agent:main:queued",
    "agent:main:capacity-wait",
  ]);
});

it("resolves progress across aliases and session IDs within the selected agent", () => {
  const incident = "incident:AbC";
  const waiting = "agent:ops:waiting";
  const index = projection([
    { ...active, agentId: "ops", sessionKey: incident, capacityWaits },
    { agentId: "ops", sessionKey: waiting, capacityWaits },
    { ...active, agentId: "other", sessionKey: incident },
    { ...active, agentId: "ops", sessionId: "running-id" },
    { sessionKey: "legacy", projectSessionActive: true },
  ]);
  const state = (
    params: Omit<Parameters<typeof resolveProjectedAgentRunProgressState>[0], "index">,
  ) => resolveProjectedAgentRunProgressState({ ...params, index });

  expect(state({ sessionKeys: [incident], agentId: " OPS " })).toBe("queued");
  expect(state({ sessionKeys: ["incident:abc"], agentId: "ops" })).toBeUndefined();
  expect(state({ sessionKeys: [incident], defaultAgentId: "ops" })).toBe("queued");
  expect(state({ sessionKeys: [incident] })).toBeUndefined();
  expect(state({ sessionKeys: [incident, "agent:other:any", waiting] })).toBe("running");
  expect(state({ sessionKeys: [incident, waiting, "agent:other:any"] })).toBe("queued");
  expect(state({ sessionKeys: [waiting], agentId: "", defaultAgentId: "ops" })).toBeUndefined();
  expect(state({ sessionKeys: [waiting] })).toBe("capacity-wait");
  expect(state({ sessionKeys: ["legacy"], agentId: "OPS", defaultAgentId: "ops" })).toBe("running");
  expect(
    state({ sessionKeys: ["legacy"], agentId: "other", defaultAgentId: "ops" }),
  ).toBeUndefined();
  for (const sessionKeys of [
    ["legacy", waiting],
    [waiting, "legacy"],
  ]) {
    expect(state({ sessionKeys, defaultAgentId: "ops" })).toBe("running");
  }
  expect(state({ sessionKeys: [waiting], sessionId: "running-id" })).toBe("running");
  expect(state({ sessionKeys: [], sessionId: "running-id", agentId: "other" })).toBeUndefined();
});

it("retains prepared progress separately for each query and run-index snapshot", () => {
  const read = prepareProjectedAgentRunProgressState({
    sessionKeys: ["agent:main:child"],
    sessionId: "child",
    agentId: "main",
  });
  const other = prepareProjectedAgentRunProgressState({
    sessionKeys: ["agent:main:child"],
    sessionId: "child",
    agentId: "other",
  });
  const inactive = projection([]);
  const running = projection([{ ...active, sessionId: "child" }]);
  using inactiveIds = vi.spyOn(inactive.sessionIds, "get");
  using runningIds = vi.spyOn(running.sessionIds, "get");
  for (let i = 0; i < 3; i++) {
    expect(read(inactive)).toBeUndefined();
    expect(read(running)).toBe("running");
    expect(other(running)).toBeUndefined();
  }
  expect(inactiveIds).toHaveBeenCalledTimes(1);
  expect(runningIds).toHaveBeenCalledTimes(2);
});
