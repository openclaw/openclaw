import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { expectOwnerGated } from "../agent-tools.turn-authority.test-support.js";
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
      agents: config.agents ?? { entries: { main: {} } },
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

function gatewayParameters(tools: AnyAgentTool[]) {
  return expectDefined(
    tools.find(({ name }) => name === "gateway"),
    "assembled gateway",
  ).parameters as {
    properties: { action: { enum: string[] } };
  };
}

function gatewayActions(config: OpenClawConfig, options?: AssemblyOptions) {
  return gatewayParameters(createTools(config, options)).properties.action.enum;
}
const readActions = ["config.get", "config.schema.lookup", "update.run"];

describe("assembled Gateway update capability", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("exposes only update inputs in the coding profile", () => {
    const tools = createTools({ tools: { profile: "coding" } });
    expect(gatewayParameters(tools).properties.action.enum).toEqual(["update.run"]);
    expect(Object.keys(gatewayParameters(tools).properties).toSorted()).toEqual(["action", "note"]);
  });

  it.each<[string, OpenClawConfig["tools"], string[], boolean]>([
    ["default", {}, readActions, true],
    ["full", { profile: "full" }, readActions, true],
    [
      "automation grant",
      { profile: "coding", alsoAllow: ["group:automation"] },
      ["config.get"],
      false,
    ],
    ["wildcard grant", { profile: "coding", alsoAllow: ["gate*"] }, ["config.get"], false],
    ["unrelated grant", { profile: "coding", alsoAllow: ["session_status"] }, ["update.run"], true],
  ])("retains config authority for %s", (_name, tools, expected, exact) => {
    const actions = gatewayActions({ tools });
    expect(actions).toEqual(exact ? expected : expect.arrayContaining(expected));
  });

  it.each([
    { mainGrant: true, providerGrant: false, configRead: false },
    { mainGrant: false, providerGrant: true, configRead: false },
    { mainGrant: true, providerGrant: true, configRead: true },
  ])(
    "requires config read grants in both limited profiles: main=$mainGrant provider=$providerGrant",
    ({ mainGrant, providerGrant, configRead }) => {
      const actions = gatewayActions({
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
      });

      expect(actions).toContain("update.run");
      expect(actions.includes("config.get")).toBe(configRead);
    },
  );

  it("uses policy-agent rather than execution-agent authority", () => {
    const actions = gatewayActions(
      {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          entries: {
            main: { tools: { profile: "coding" } },
            execution: { tools: { profile: "full" } },
          },
        },
      },
      {
        agentId: "execution",
        policyAgentId: "main",
        sessionKey: "global",
        runSessionKey: "agent:execution:main",
      },
    );

    expect(actions).toContain("update.run");
    expect(actions).not.toContain("config.get");
  });

  it.each([
    { name: "explicit deny", tools: { deny: ["gateway"] } },
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
  ])("preserves the $name boundary", async ({ options }) => {
    const tools = createTools({ tools: { profile: "coding" } }, options);
    // A non-owner turn keeps the stable definition and is gated when it calls the tool.
    const nonOwner = "senderIsOwner" in options && options.senderIsOwner === false;
    expect(tools.some((tool) => tool.name === "gateway")).toBe(nonOwner);
    await expectOwnerGated(tools, "gateway");
  });
});
