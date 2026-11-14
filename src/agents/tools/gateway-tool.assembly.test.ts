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
  const tool = tools.find((candidate) => candidate.name === "gateway");
  if (!tool) {
    throw new Error("Expected gateway tool in the assembled profile");
  }
  return tool.parameters as {
    properties: { action: { enum: string[] } };
  };
}

function gatewayActions(tools: AnyAgentTool[]) {
  return gatewayParameters(tools).properties.action.enum;
}

const updateActions = ["update.run", "restart", "update.cleanup"];

describe("assembled Gateway update capability", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("makes update actions available in the coding profile without config reads", () => {
    const tools = createTools({ tools: { profile: "coding" } });
    expect(gatewayActions(tools)).toEqual(updateActions);
    expect(Object.keys(gatewayParameters(tools).properties).toSorted()).toEqual([
      "action",
      "dryRun",
      "note",
    ]);
  });

  it.each([undefined, "full"] as const)(
    "retains existing config read authority with profile %s",
    (profile) => {
      expect(gatewayActions(createTools({ tools: { profile } }))).toEqual([
        "config.get",
        "config.schema.lookup",
        ...updateActions,
      ]);
    },
  );

  it.each(["group:automation", "gate*"])(
    "retains explicit config read authority from alsoAllow %s",
    (grant) => {
      expect(
        gatewayActions(createTools({ tools: { profile: "coding", alsoAllow: [grant] } })),
      ).toContain("config.get");
    },
  );

  it("does not widen config reads from unrelated alsoAllow", () => {
    expect(
      gatewayActions(
        createTools({
          tools: { profile: "coding", alsoAllow: ["session_status"] },
        }),
      ),
    ).toEqual(updateActions);
  });

  it.each([
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])(
    "requires config read grants in both limited profiles: main=%s provider=%s",
    (mainGrant, providerGrant, configRead) => {
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

  it("uses the policy agent's authority rather than the execution agent's", () => {
    const actions = gatewayActions(
      createTools(
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
      ),
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
