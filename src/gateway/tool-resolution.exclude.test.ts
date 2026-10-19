import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import type { createOpenClawCodingTools } from "../agents/agent-tools.js";
import type { createLazyExecTool } from "../agents/lazy-exec-tool.js";
import type { createOpenClawTools } from "../agents/openclaw-tools.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CreateOpenClawToolsArg = Parameters<typeof createOpenClawTools>[0];
type CreateOpenClawCodingToolsArg = Parameters<typeof createOpenClawCodingTools>[0];
type LazyExecToolDefaults = Parameters<typeof createLazyExecTool>[0];
type LazyExecToolPresentation = Parameters<typeof createLazyExecTool>[1];
type ResolveOptions = Partial<Parameters<typeof resolveGatewayScopedTools>[0]>;
const toolNames = (result: Awaited<ReturnType<typeof resolveGatewayScopedTools>>) =>
  result.tools.map(({ name }) => name);

const { makeTool, createTools, codingTools, createExec, getChannelPlugin } = vi.hoisted(() => {
  function buildTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  const execTool = vi.fn(
    (_defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) => ({
      ...buildTool("exec"),
      description: presentation?.description ?? "exec tool",
      parameters: presentation?.parameters ?? { type: "object", properties: {} },
    }),
  );
  return {
    makeTool: buildTool,
    createExec: execTool,
    getChannelPlugin: vi.fn(),
    codingTools: vi.fn((_args: CreateOpenClawCodingToolsArg): ReturnType<typeof buildTool>[] => []),
    createTools: vi.fn((_args: CreateOpenClawToolsArg) =>
      ["read", "sessions_spawn", "automations", "gateway", "nodes"].map(buildTool),
    ),
  };
});

// mock-isolation: Scope fixture Gateway tools without constructing plugin or channel integrations.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async (...args: Parameters<typeof createTools>) => createTools(...args),
}));

// mock-isolation: Filter synthetic mediated tools without filesystem or exec initialization.
vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingToolsInternalAsync: async (...args: Parameters<typeof codingTools>) =>
    codingTools(...args),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: getChannelPlugin,
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: createExec,
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

async function resolveTools(overrides: ResolveOptions = {}) {
  return await resolveGatewayScopedTools({
    cfg: {},
    sessionKey: "agent:main:direct:test",
    surface: "loopback",
    ...overrides,
  });
}

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    createTools.mockClear();
    createExec.mockClear();
    codingTools.mockReset();
    codingTools.mockReturnValue([]);
    getChannelPlugin.mockReset();
  });

  function mockTools(...names: string[]) {
    createTools.mockReturnValueOnce(names.map(makeTool));
  }

  function readCreateToolsArgs(index = 0) {
    const args = createTools.mock.calls[index]?.[0];
    if (!args) {
      throw new Error("expected createOpenClawTools args");
    }
    return args;
  }

  async function resolveNodeExecTools(overrides: ResolveOptions = {}) {
    return await resolveTools({
      senderIsOwner: true,
      includeNodeExecTool: true,
      nodeExecAvailable: () => true,
      ...overrides,
    });
  }

  it("passes immutable source-reply authority into message-tool construction", async () => {
    await resolveTools({
      sessionKey: "agent:main:telegram:group:chat123",
      messageProvider: "telegram",
      currentChannelId: "telegram:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplyOnly: true,
    });

    expect(readCreateToolsArgs().sourceReplyOnly).toBe(true);
  });

  it("rejects loopback tool construction after the scheduled owner account is removed", async () => {
    const resolveToolPolicy = vi.fn(() => ({ allow: ["read"] }));
    getChannelPlugin.mockReturnValue({
      config: {
        listAccountIds: (cfg: OpenClawConfig) => Object.keys(cfg.channels?.discord?.accounts ?? {}),
      },
      groups: { resolveToolPolicy },
    });
    const scheduledToolPolicy = {
      version: 1 as const,
      mode: "account" as const,
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "creator",
    };
    const resolveForAccounts = async (accounts: string[]) =>
      await resolveTools({
        cfg: {
          channels: { discord: { accounts: Object.fromEntries(accounts.map((id) => [id, {}])) } },
        },
        sessionKey: "agent:main:cron:run-1",
        runtimePolicySessionKey: "agent:main:cron:run-1",
        accountId: "delivery",
        scheduledToolPolicy,
      });
    expect(toolNames(await resolveForAccounts(["creator", "delivery"]))).toEqual(["read"]);
    createTools.mockClear();
    await expect(resolveForAccounts(["delivery"])).rejects.toThrow(
      'Scheduled account "creator" is unavailable',
    );
    expect(createTools).not.toHaveBeenCalled();
    expect(resolveToolPolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accountId: "creator", groupId: "ops" }),
    );
  });

  it("does not fall back when policy removes a mediated coding tool", async () => {
    mockTools("write", "automations");

    const result = await resolveTools({
      sessionKey: "agent:main:cron:run-1",
      mediatedToolNames: ["write"],
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
    });

    expect(toolNames(result)).toEqual(["automations"]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", async () => {
    const names = ["read", "sessions_spawn", "automations", "gateway", "plugins", "nodes"];
    createTools.mockReturnValueOnce(names.map(makeTool)).mockReturnValueOnce(names.map(makeTool));
    const cfg = { gateway: { tools: { allow: ["gateway", "plugins"] } } };
    const ownerResult = await resolveTools({ cfg, senderIsOwner: true });
    const nonOwnerResult = await resolveTools({ cfg, senderIsOwner: false });
    expect(toolNames(ownerResult)).toEqual(names);
    expect(toolNames(nonOwnerResult)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs(1);
    const denied = [
      "automations",
      "gateway",
      "plugins",
      "screen",
      "terminal",
      "portal",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "nodes",
      "computer",
      "mobile_ui",
      "openclaw",
      "sessions",
    ];
    expect(args).toMatchObject({ pluginToolDenylist: denied, inheritedToolDenylist: denied });
  });

  it.each([
    ["loopback", undefined, "missing", false, false],
    ["loopback", false, "live", false, true],
    ["loopback", false, "retired", false, false],
    ["loopback", false, "live", true, false],
    ["http", false, "live", false, false],
    ["http", true, "missing", false, true],
  ] as const)(
    "keeps assignment scoped to %s owner=%s authority=%s deny=%s available=%s",
    async (surface, senderIsOwner, authority, denied, available) => {
      const admission = prepareSystemAgentRunAdmission({}, "assignment-scope", "main", "test");
      try {
        const admittedRunContext =
          authority === "missing" ? undefined : await admission.admit("gateway");
        if (authority === "retired") {
          admission.close();
        }
        createTools.mockReturnValueOnce([makeTool("sessions")]);
        const result = await resolveTools({
          cfg: {
            gateway: { tools: { allow: ["sessions"] } },
            ...(denied ? { tools: { deny: ["sessions"] } } : {}),
          },
          sessionKey: "agent:main:main",
          surface,
          senderIsOwner,
          admittedRunContext,
        });
        expect(result.tools.some((tool) => tool.name === "sessions")).toBe(available);
        expect(readCreateToolsArgs().senderIsOwner).toBe(senderIsOwner);
      } finally {
        admission.close();
      }
    },
  );

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", async () => {
    const result = await resolveNodeExecTools({
      cfg: { gateway: { tools: { deny: ["exec"] } } },
      excludeToolNames: ["read", "apply_patch"],
    });
    expect(toolNames(result)).toEqual(["sessions_spawn", "automations", "gateway", "nodes"]);
    const args = readCreateToolsArgs();
    expect(args).toMatchObject({ pluginToolDenylist: ["exec"], inheritedToolDenylist: ["exec"] });
  });

  it.each([false, true])(
    "gates node exec with the runtime policy agent binding: %s",
    async (available) => {
      const result = await resolveTools({
        cfg: {
          agents: {
            entries: {
              main: { tools: { exec: { node: "outer-node" } } },
              worker: { tools: { exec: { node: "worker-node" } } },
            },
          },
        },
        runtimePolicySessionKey: "agent:worker:direct:test",
        runtimePolicyAgentId: "worker",
        senderIsOwner: true,
        includeNodeExecTool: true,
        nodeExecAvailable: (node) => available && node === "worker-node",
      });
      expect(result.tools.some((tool) => tool.name === "exec")).toBe(available);
    },
  );

  it("adds a synchronous node-forced exec tool to allowed owner loopback scopes", async () => {
    mockTools("read", "exec", "nodes");
    const elevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "ask",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "runtime",
    } as const;
    const result = await resolveNodeExecTools({ bashElevated: elevated });

    expect(toolNames(result).filter((name) => name === "exec")).toEqual(["exec"]);
    expect(createExec).toHaveBeenCalledOnce();
    expect(createExec.mock.calls[0]?.[0]).toMatchObject({
      host: "node",
      allowBackground: false,
      elevated,
    });
    const presentation = createExec.mock.calls[0]?.[1];
    expect(presentation?.description).toContain("node-only");
    expect(presentation?.parameters).toHaveProperty("properties.host.enum", ["node"]);
  });

  it.each<[string, ResolveOptions]>([
    ["Gateway host", { execSession: { execHost: "gateway" } }],
    [
      "turn host override",
      {
        execSession: { execHost: "node" },
        execOverrides: { host: "gateway" },
      },
    ],
    ["sandbox", { cfg: { agents: { defaults: { sandbox: { mode: "all" } } } } }],
    [
      "runtime policy sandbox",
      {
        cfg: { agents: { defaults: { sandbox: { mode: "non-main" } } } },
        sessionKey: "agent:main:main",
        runtimePolicySessionKey: "agent:main:discord:default:direct:peer-42",
        agentId: "main",
      },
    ],
    ["HTTP surface", { surface: "http" }],
  ])("omits every exec variant for %s", async (_label, options) => {
    mockTools("read", "exec", "nodes");
    const result = await resolveNodeExecTools(options);
    expect(toolNames(result)).not.toContain("exec");
    expect(createExec).not.toHaveBeenCalled();
  });

  it.each([
    { channel: "discord", sender: "blocked-sender", available: false },
    { channel: "discord", sender: "*", available: false },
    { channel: "webchat", sender: "*", available: true },
  ])("applies $sender sender policy on $channel", async ({ channel, sender, available }) => {
    const result = await resolveNodeExecTools({
      cfg: {
        tools: {
          toolsBySender: {
            [sender === "*" ? sender : `id:${sender}`]: {
              deny: ["exec"],
            },
          },
        },
      },
      sessionKey: channel === "webchat" ? "agent:main:main" : "agent:main:discord:channel:dev",
      senderIsOwner: sender === "*",
      messageProvider: channel,
      ...(sender !== "*" ? { channelContext: { sender: { id: sender } } } : {}),
    });
    expect(toolNames(result).includes("exec")).toBe(available);
    expect(readCreateToolsArgs().pluginToolDenylist?.includes("exec")).toBe(!available);
  });

  it("filters node exec through plugin group policy bound to group labels", async () => {
    const resolveToolPolicy = vi.fn(
      (params: { groupChannel?: string | null; groupSpace?: string | null }) =>
        params.groupChannel === "ops" && params.groupSpace === "guild-blocked"
          ? { deny: ["exec"] }
          : undefined,
    );
    getChannelPlugin.mockReturnValue({ groups: { resolveToolPolicy } });
    const group = { groupId: "bound", groupChannel: "ops", groupSpace: "guild-blocked" };
    const result = await resolveNodeExecTools({
      ...group,
      sessionKey: "agent:main:direct:child",
      spawnedBy: "agent:main:discord:channel:bound",
      senderIsOwner: false,
      messageProvider: "discord",
    });
    expect(resolveToolPolicy).toHaveBeenCalledWith(expect.objectContaining(group));
    expect(toolNames(result)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("does not inherit node-only exec as a generic child or cron capability", async () => {
    const result = await resolveNodeExecTools({
      cfg: { tools: { allow: ["exec", "sessions_spawn", "automations"] } },
    });

    expect(toolNames(result)).toContain("exec");
    expect(readCreateToolsArgs().inheritedToolAllowlist).not.toContain("exec");
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).not.toContainEqual({ name: "exec" });
  });

  it("captures report-only authority after removing delegation launchers", async () => {
    const names = ["read", "sessions_spawn", "sessions_send", "cron", "gateway", "nodes"];
    mockTools(...names);
    const result = await resolveTools({
      cfg: { tools: { allow: names } },
      senderIsOwner: true,
      delegationCapability: "report_only",
    });
    expect(toolNames(result)).toEqual(["read", "cron", "gateway", "nodes"]);
    const inherited = ["read", "automations", "gateway", "nodes"];
    expect(readCreateToolsArgs().inheritedToolAllowlist).toEqual(inherited);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual(
      inherited.map((name) => ({ name })),
    );
  });

  it("narrows report-only loopback tools to their status actions", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    createTools.mockReturnValueOnce([{ ...makeTool("cron"), execute }]);
    const cron = (
      await resolveTools({
        senderIsOwner: true,
        delegationCapability: "report_only",
      })
    ).tools.find((tool) => tool.name === "cron");
    await expect(cron?.execute("cron-status", { action: "status" })).resolves.toEqual({
      content: [],
      details: {},
    });
    await expect(cron?.execute("cron-add", { action: "add" })).rejects.toThrow(
      "New delegation is unavailable",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
