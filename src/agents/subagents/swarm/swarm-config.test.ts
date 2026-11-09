import { expect, it } from "vitest";
import { resolveSwarmConfig } from "./swarm-config.js";

type Swarm = NonNullable<NonNullable<Parameters<typeof resolveSwarmConfig>[0]>["tools"]>["swarm"];
const withAgent = (global: Swarm, agent: Swarm) => ({
  tools: { swarm: global },
  agents: { entries: { main: { tools: { swarm: agent } } } },
});

it("defaults to no named agent", () => {
  expect(resolveSwarmConfig().defaultAgentId).toBe("");
});

it("merges per-agent values, inherits global values and trims the agent ID", () => {
  const config = withAgent(
    { maxConcurrent: 1, maxTotalPerGroup: 2, defaultAgentId: " reviewer " },
    { maxConcurrent: 4 },
  );
  expect(resolveSwarmConfig(config, "main")).toMatchObject({
    maxConcurrent: 4,
    maxTotalPerGroup: 2,
    defaultAgentId: "reviewer",
  });
});

it.each([
  { field: "maxConcurrent", fallback: 32, max: 1_000 },
  { field: "maxChildrenPerGroup", fallback: 50, max: 10_000 },
  { field: "maxTotalPerGroup", fallback: 200, max: 100_000 },
  { field: "waitTimeoutSecondsMax", fallback: 600, max: 86_400 },
] as const)("preserves the documented bounds for $field", ({ field, fallback, max }) => {
  expect(resolveSwarmConfig({ tools: { swarm: {} } })[field]).toBe(fallback);
  for (const [value, expected] of [
    [1, 1],
    [max, max],
    [max + 1, max],
  ]) {
    expect(resolveSwarmConfig({ tools: { swarm: { [field]: value } } })[field]).toBe(expected);
  }
});

it.each([
  ["omitted tools", {}, true],
  ["omitted swarm", { tools: {} }, true],
  ["empty swarm", { tools: { swarm: {} } }, true],
  ["limits-only swarm", { tools: { swarm: { maxConcurrent: 2 } } }, true],
  ["boolean opt-in", { tools: { swarm: true } }, true],
  ["boolean opt-out", { tools: { swarm: false } }, false],
  ["object opt-out", { tools: { swarm: { enabled: false } } }, false],
  ["per-agent opt-out", { agents: { entries: { main: { tools: { swarm: false } } } } }, false],
  ["per-agent limits inherit global opt-out", withAgent(false, { maxConcurrent: 2 }), false],
  ["per-agent empty object inherits global opt-out", withAgent({ enabled: false }, {}), false],
  ["per-agent opt-in overrides global opt-out", withAgent(false, true), true],
  ["agent object opt-out overrides global opt-in", withAgent(true, { enabled: false }), false],
] as const)("honors %s", (_name, config, enabled) => {
  expect(resolveSwarmConfig(config, "main").enabled).toBe(enabled);
});
