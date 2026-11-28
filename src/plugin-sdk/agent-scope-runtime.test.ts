import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  listAgentIds,
  resolveSessionAgentId,
  resolveSessionAgentIdStrict,
  resolveSessionAgentIds,
  resolveSessionAgentIdsStrict,
} from "./agent-scope-runtime.js";

describe("agent-scope-runtime compatibility", () => {
  it("returns independently writable agent ids for immutable runtime config", () => {
    const captured = freezeJsonSnapshot({ agents: { entries: { main: {}, ops: {} } } });
    const ids = listAgentIds(captured);
    ids.splice(0, ids.length, "replacement");
    expect(ids).toEqual(["replacement"]);
    expect(listAgentIds(captured)).toEqual(["main", "ops"]);
  });

  const config = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "beta" } },
      entries: { main: {}, beta: {} },
    },
  } satisfies OpenClawConfig;
  const persistedConfig = (agentId = "main"): OpenClawConfig => ({
    ...config,
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ...config.agents,
      defaults: { ...config.agents.defaults, sessionStore: { agentId } },
    },
  });

  it.each([undefined, "", " \t "])(
    "resolves the configured system agent for ownerless shipped calls with agentId %j",
    (agentId) => {
      expect(resolveSessionAgentIds({ config, agentId })).toEqual({
        defaultAgentId: "beta",
        sessionAgentId: "beta",
      });
      expect(resolveSessionAgentId({ config, agentId })).toBe("beta");
    },
  );

  it.each([
    { agentId: undefined, error: AgentSelectionRequiredError },
    { agentId: "", error: "Invalid explicit agent id" },
    { agentId: " \t ", error: "Invalid explicit agent id" },
  ])("preserves strict rejection for agentId $agentId", ({ agentId, error }) => {
    expect(() => resolveSessionAgentIdsStrict({ config, agentId })).toThrow(error);
    expect(() => resolveSessionAgentIdStrict({ config, agentId })).toThrow(error);
  });

  it.each([
    { agentId: "!!!", error: "Invalid explicit agent id" },
    { sessionKey: "agent::broken", error: "Malformed agent session key" },
  ])("does not replace invalid selectors with the system agent: %j", ({ error, ...selector }) => {
    expect(() => resolveSessionAgentIds({ config, ...selector })).toThrow(error);
    expect(() => resolveSessionAgentId({ config, ...selector })).toThrow(error);
  });

  it.each([
    ["explicit agent", { config, agentId: "main" }],
    ["prepared fallback agent", { config, fallbackAgentId: "main" }],
    ["agent-scoped session key", { config, sessionKey: "agent:main:main" }],
    ["prepared fallback with blank ID", { config, agentId: "", fallbackAgentId: "main" }],
    ["session key with blank ID", { config, agentId: " \t ", sessionKey: "agent:main:main" }],
    ["persisted fixed-store owner", { config: persistedConfig(), sessionKey: "global" }],
  ] satisfies Array<[string, Parameters<typeof resolveSessionAgentIds>[0]]>)(
    "does not override %s",
    (_name, params) => {
      expect(resolveSessionAgentIds(params).sessionAgentId).toBe("main");
    },
  );

  it.each([
    {
      name: "conflicting explicit and agent-scoped owners",
      params: { config, agentId: "beta", sessionKey: "agent:main:main" },
    },
    {
      name: "conflicting explicit and persisted owners",
      params: {
        config: persistedConfig(),
        agentId: "beta",
        sessionKey: "global",
      },
    },
    {
      name: "retired persisted owner",
      params: {
        config: persistedConfig("retired"),
        sessionKey: "global",
      },
    },
  ])("preserves $name failures", ({ params }) => {
    expect(() => resolveSessionAgentIds(params)).toThrow(AgentSelectionRequiredError);
  });
});
