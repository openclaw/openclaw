import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveSessionAgentId,
  resolveSessionAgentIdStrict,
  resolveSessionAgentIds,
  resolveSessionAgentIdsStrict,
} from "./agent-scope-runtime.js";

describe("agent-scope-runtime compatibility", () => {
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "beta" } },
      entries: { main: {}, beta: {} },
    },
  } satisfies OpenClawConfig;

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
    {
      name: "explicit agent",
      params: { config, agentId: "main" },
      expected: "main",
    },
    {
      name: "prepared fallback agent",
      params: { config, fallbackAgentId: "main" },
      expected: "main",
    },
    {
      name: "agent-scoped session key",
      params: { config, sessionKey: "agent:main:main" },
      expected: "main",
    },
    {
      name: "prepared fallback agent with a blank explicit ID",
      params: { config, agentId: "", fallbackAgentId: "main" },
      expected: "main",
    },
    {
      name: "agent-scoped session key with a blank explicit ID",
      params: { config, agentId: " \t ", sessionKey: "agent:main:main" },
      expected: "main",
    },
    {
      name: "persisted fixed-store owner",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "main" },
            },
          },
        },
        sessionKey: "global",
      },
      expected: "main",
    },
  ])("does not override $name", ({ params, expected }) => {
    expect(resolveSessionAgentIds(params).sessionAgentId).toBe(expected);
  });

  it.each([
    {
      name: "conflicting explicit and agent-scoped owners",
      params: { config, agentId: "beta", sessionKey: "agent:main:main" },
    },
    {
      name: "conflicting explicit and persisted owners",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "main" },
            },
          },
        },
        agentId: "beta",
        sessionKey: "global",
      },
    },
    {
      name: "retired persisted owner",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "retired" },
            },
          },
        },
        sessionKey: "global",
      },
    },
  ])("preserves $name failures", ({ params }) => {
    expect(() => resolveSessionAgentIds(params)).toThrow(AgentSelectionRequiredError);
  });
});
