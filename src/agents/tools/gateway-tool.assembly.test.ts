import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import "../test-helpers/fast-coding-tools.js";
import type { AnyAgentTool } from "./common.js";

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type AssemblyOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

function createTools(config: OpenClawConfig, options: AssemblyOptions = {}) {
  return createOpenClawCodingTools({
    config: {
      ...config,
      agents: config.agents ?? { entries: { main: { default: true } } },
    },
    sessionKey: "agent:main:main",
    senderIsOwner: true,
    modelProvider: "openai",
    modelId: "gpt-5.6-sol",
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
    ...options,
  });
}

function requireGateway(tools: AnyAgentTool[]) {
  const tool = tools.find((candidate) => candidate.name === "gateway");
  if (!tool) {
    throw new Error("Expected gateway tool in the assembled profile");
  }
  return tool;
}

function gatewayParameters(tools: AnyAgentTool[]) {
  return requireGateway(tools).parameters as {
    properties: { action: { enum: string[] } };
  };
}

function gatewayActions(tools: AnyAgentTool[]) {
  return gatewayParameters(tools).properties.action.enum;
}

describe("assembled Gateway update capability", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["minimal", "coding", "messaging"] as const)(
    "makes the existing update action available in the %s profile without config reads",
    (profile) => {
      const tools = createTools({ tools: { profile } });

      expect(gatewayActions(tools)).toEqual(["update.run"]);
      expect(Object.keys(gatewayParameters(tools).properties).toSorted()).toEqual([
        "action",
        "note",
      ]);
    },
  );

  it.each([undefined, "full"] as const)(
    "retains existing config read authority with profile %s",
    (profile) => {
      expect(gatewayActions(createTools({ tools: { profile } }))).toEqual([
        "config.get",
        "config.schema.lookup",
        "update.run",
      ]);
    },
  );

  it.each(["gateway", "group:automation", "gate*", "*"])(
    "retains explicit config read authority from alsoAllow %s",
    (grant) => {
      expect(
        gatewayActions(createTools({ tools: { profile: "coding", alsoAllow: [grant] } })),
      ).toContain("config.get");
    },
  );

  it.each([
    { alsoAllow: [] },
    { alsoAllow: [""] },
    { alsoAllow: ["   "] },
    { alsoAllow: ["session_status"] },
  ])("does not widen config reads from alsoAllow $alsoAllow", ({ alsoAllow }) => {
    expect(gatewayActions(createTools({ tools: { profile: "coding", alsoAllow } }))).toEqual([
      "update.run",
    ]);
  });

  it.each([
    { mainGrant: false, providerGrant: false, configRead: false },
    { mainGrant: true, providerGrant: false, configRead: false },
    { mainGrant: false, providerGrant: true, configRead: false },
    { mainGrant: true, providerGrant: true, configRead: true },
  ])(
    "requires config read grants in both limited profiles: main=$mainGrant provider=$providerGrant",
    ({ mainGrant, providerGrant, configRead }) => {
      const actions = gatewayActions(
        createTools({
          tools: {
            profile: "coding",
            ...(mainGrant ? { alsoAllow: ["gateway"] } : {}),
            byProvider: {
              openai: {
                profile: "minimal",
                ...(providerGrant ? { alsoAllow: ["gateway"] } : {}),
              },
            },
          },
        }),
      );

      expect(actions).toContain("update.run");
      expect(actions.includes("config.get")).toBe(configRead);
    },
  );

  it.each(["coding", "full"] as const)(
    "uses the %s policy agent's authority rather than the execution agent's",
    (policyProfile) => {
      const actions = gatewayActions(
        createTools(
          {
            session: { scope: "global" },
            agents: {
              ownership: "explicit",
              entries: {
                main: { default: true, tools: { profile: policyProfile } },
                execution: { tools: { profile: policyProfile === "full" ? "coding" : "full" } },
              },
            },
          },
          {
            agentId: "execution",
            policyAgentId: "main",
            sessionKey: "global",
            runSessionKey: "agent:execution:main",
          },
        ),
      );

      expect(actions).toContain("update.run");
      expect(actions.includes("config.get")).toBe(policyProfile === "full");
    },
  );

  it.each([
    { name: "explicit deny", tools: { deny: ["gateway"] } },
    { name: "group deny", tools: { deny: ["group:automation"] } },
    { name: "restrictive allow", tools: { allow: ["session_status"] } },
    { name: "provider deny", tools: { byProvider: { openai: { deny: ["gateway"] } } } },
  ])("preserves $name restrictions", ({ tools }) => {
    expect(
      createTools({ tools: { profile: "coding", ...tools } }).map((tool) => tool.name),
    ).not.toContain("gateway");
  });

  it.each([
    { name: "non-owner", options: { senderIsOwner: false } },
    {
      name: "subagent",
      options: { sessionKey: "agent:main:subagent:worker", senderIsOwner: true },
    },
    {
      name: "conversation allowlist",
      options: { conversationToolPolicy: { allow: ["session_status"] } },
    },
    {
      name: "runtime allowlist",
      options: { runtimeToolAllowlist: ["session_status"], inheritRuntimeToolAllowlist: true },
    },
  ])("preserves the $name boundary", ({ options }) => {
    expect(
      createTools({ tools: { profile: "coding" } }, options).map((tool) => tool.name),
    ).not.toContain("gateway");
  });
});
