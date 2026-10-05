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

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: createTools,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: codingTools,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: getChannelPlugin,
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: createExec,
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

function resolveTools(overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {}) {
  return resolveGatewayScopedTools({
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

  function resolveNodeExecTools(
    overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {},
  ) {
    return resolveTools({
      senderIsOwner: true,
      includeNodeExecTool: true,
      nodeExecAvailable: () => true,
      ...overrides,
    });
  }

  it("passes immutable source-reply authority into message-tool construction", () => {
    resolveTools({
      sessionKey: "agent:main:telegram:group:chat123",
      messageProvider: "telegram",
      currentChannelId: "telegram:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplyOnly: true,
    });

    expect(readCreateToolsArgs().sourceReplyOnly).toBe(true);
  });

  it("constructs exact coding tools for a server-minted mediated grant", () => {
    codingTools.mockReturnValueOnce([makeTool("write")]);

    const scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:qa-channel:group:ops",
      ownerAccountId: "default",
      ownerOrigin: { kind: "external", channel: "qa-channel" },
    } satisfies NonNullable<Parameters<typeof resolveGatewayScopedTools>[0]["scheduledToolPolicy"]>;
    const result = resolveTools({
      cfg: { tools: { exec: { host: "node" } } },
      sessionKey: "agent:main:cron:run-1",
      runtimePolicySessionKey: "agent:main:qa-channel:group:ops",
      runId: "run-1",
      workspaceDir: "/workspace",
      cwd: "/workspace/task",
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
      mediatedToolNames: ["write"],
      scheduledToolPolicy,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("write");
    expect(codingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeToolAllowlist: ["write"],
        sessionKey: "agent:main:qa-channel:group:ops",
        runSessionKey: "agent:main:cron:run-1",
        workspaceDir: "/workspace",
        cwd: "/workspace/task",
        wrapBeforeToolCallHook: false,
        scheduledToolPolicy,
      }),
    );
    expect(readCreateToolsArgs()).toMatchObject({
      agentChannel: undefined,
      agentAccountId: undefined,
      gatewayCallerAccountId: "default",
      gatewayCallerChannel: "qa-channel",
    });
    expect(createExec).not.toHaveBeenCalled();
  });

  it("rejects loopback tool construction after the scheduled owner account is removed", () => {
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
    const resolveForAccounts = (accounts: string[]) =>
      resolveTools({
        cfg: {
          channels: { discord: { accounts: Object.fromEntries(accounts.map((id) => [id, {}])) } },
        },
        sessionKey: "agent:main:cron:run-1",
        runtimePolicySessionKey: "agent:main:cron:run-1",
        accountId: "delivery",
        scheduledToolPolicy,
      });
    expect(resolveForAccounts(["creator", "delivery"]).tools.map((tool) => tool.name)).toEqual([
      "read",
    ]);
    createTools.mockClear();
    expect(() => resolveForAccounts(["delivery"])).toThrow(
      'Scheduled account "creator" is unavailable',
    );
    expect(createTools).not.toHaveBeenCalled();
    expect(resolveToolPolicy).toHaveBeenCalledTimes(1);
    expect(resolveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "creator",
        groupId: "ops",
      }),
    );
  });

  it("does not fall back when policy removes a mediated coding tool", () => {
    mockTools("write", "automations");

    const result = resolveTools({
      sessionKey: "agent:main:cron:run-1",
      mediatedToolNames: ["write"],
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["automations"]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", () => {
    const names = ["read", "sessions_spawn", "automations", "gateway", "plugins", "nodes"];
    createTools.mockReturnValueOnce(names.map(makeTool)).mockReturnValueOnce(names.map(makeTool));
    const cfg = { gateway: { tools: { allow: ["gateway", "plugins"] } } };
    const ownerResult = resolveTools({ cfg, senderIsOwner: true });
    const nonOwnerResult = resolveTools({ cfg, senderIsOwner: false });
    expect(ownerResult.tools.map((tool) => tool.name)).toEqual(names);
    expect(nonOwnerResult.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
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
    expect(args.pluginToolDenylist).toEqual(denied);
    expect(args.inheritedToolDenylist).toEqual(denied);
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
          await admission.close();
        }
        createTools.mockReturnValueOnce([makeTool("sessions")]);
        const result = resolveTools({
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
        await admission.close();
      }
    },
  );

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", () => {
    const result = resolveNodeExecTools({
      cfg: { gateway: { tools: { deny: ["exec"] } } },
      excludeToolNames: ["read", "apply_patch"],
    });
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "sessions_spawn",
      "automations",
      "gateway",
      "nodes",
    ]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual(["exec"]);
    expect(args.inheritedToolDenylist).toEqual(["exec"]);
  });

  it.each([false, true])(
    "gates node exec with the runtime policy agent binding: %s",
    (available) => {
      const result = resolveTools({
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

  it("adds a synchronous node-forced exec tool to allowed owner loopback scopes", () => {
    mockTools("read", "exec", "nodes");
    const elevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "ask",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "runtime",
    } as const;
    const result = resolveNodeExecTools({ bashElevated: elevated });

    expect(result.tools.map((tool) => tool.name).filter((name) => name === "exec")).toEqual([
      "exec",
    ]);
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

  it("omits all exec variants when host policy forbids node execution", () => {
    mockTools("read", "exec", "nodes");
    const gatewayOnly = resolveNodeExecTools({
      execSession: { execHost: "gateway" },
    });
    mockTools("read", "exec", "nodes");
    const turnOverrideGateway = resolveNodeExecTools({
      execSession: { execHost: "node" },
      execOverrides: { host: "gateway" },
    });
    mockTools("read", "exec", "nodes");
    const sandboxAuto = resolveNodeExecTools({
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
    });

    expect(gatewayOnly.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(turnOverrideGateway.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(sandboxAuto.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(createExec).not.toHaveBeenCalled();
  });

  it("uses the runtime policy key for non-main sandbox classification", () => {
    const result = resolveNodeExecTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:discord:default:direct:peer-42",
      agentId: "main",
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(createExec).not.toHaveBeenCalled();
  });

  it("does not honor the internal node-exec flag on HTTP surfaces", () => {
    mockTools("read", "exec", "nodes");
    const result = resolveNodeExecTools({
      surface: "http",
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(createExec).not.toHaveBeenCalled();
  });

  it("filters node exec through immutable sender-scoped policy", () => {
    const result = resolveNodeExecTools({
      cfg: {
        tools: {
          toolsBySender: {
            "id:blocked-sender": { deny: ["exec"] },
          },
        },
      },
      sessionKey: "agent:main:discord:channel:dev",
      senderIsOwner: false,
      messageProvider: "discord",
      channelContext: { sender: { id: "blocked-sender" } },
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("filters node exec through plugin group policy bound to group labels", () => {
    const resolveToolPolicy = vi.fn(
      (params: { groupChannel?: string | null; groupSpace?: string | null }) =>
        params.groupChannel === "ops" && params.groupSpace === "guild-blocked"
          ? { deny: ["exec"] }
          : undefined,
    );
    getChannelPlugin.mockReturnValue({
      groups: { resolveToolPolicy },
    });

    const result = resolveNodeExecTools({
      sessionKey: "agent:main:direct:child",
      spawnedBy: "agent:main:discord:channel:bound",
      groupId: "bound",
      groupChannel: "ops",
      groupSpace: "guild-blocked",
      senderIsOwner: false,
      messageProvider: "discord",
    });

    expect(resolveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "bound",
        groupChannel: "ops",
        groupSpace: "guild-blocked",
      }),
    );
    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  const wildcardExecDeny = { tools: { toolsBySender: { "*": { deny: ["exec"] } } } };

  it("applies wildcard sender policy to owners on external channels", () => {
    const result = resolveNodeExecTools({
      cfg: wildcardExecDeny,
      sessionKey: "agent:main:discord:channel:dev",
      senderIsOwner: true,
      messageProvider: "discord",
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("preserves owner WebChat access from wildcard sender policy", () => {
    const result = resolveNodeExecTools({
      cfg: wildcardExecDeny,
      sessionKey: "agent:main:main",
      messageProvider: "webchat",
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).not.toContain("exec");
  });

  it("does not inherit node-only exec as a generic child or cron capability", () => {
    const result = resolveNodeExecTools({
      cfg: { tools: { allow: ["exec", "sessions_spawn", "automations"] } },
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().inheritedToolAllowlist).not.toContain("exec");
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).not.toContainEqual({ name: "exec" });
  });

  it("captures report-only authority after removing delegation launchers", () => {
    createTools.mockReturnValueOnce(
      ["read", "sessions_spawn", "sessions_send", "cron", "gateway", "nodes"].map(makeTool),
    );
    const result = resolveTools({
      cfg: {
        tools: { allow: ["read", "sessions_spawn", "sessions_send", "cron", "gateway", "nodes"] },
      },
      senderIsOwner: true,
      delegationCapability: "report_only",
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron", "gateway", "nodes"]);
    expect(readCreateToolsArgs().inheritedToolAllowlist).toEqual([
      "read",
      "automations",
      "gateway",
      "nodes",
    ]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "automations" },
      { name: "gateway" },
      { name: "nodes" },
    ]);
  });

  it("narrows report-only loopback tools to their status actions", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    createTools.mockReturnValueOnce([{ ...makeTool("cron"), execute }]);
    const cron = resolveTools({
      senderIsOwner: true,
      delegationCapability: "report_only",
    }).tools.find((tool) => tool.name === "cron");
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
