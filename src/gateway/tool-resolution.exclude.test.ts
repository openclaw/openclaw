/**
 * Gateway tool-resolution exclusion tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAuthorizationPrincipal } from "../plugins/authorization-policy-context.js";
import type { AuthorizationInvocationContext } from "../plugins/authorization-policy.types.js";

type CreateOpenClawToolsArg = {
  agentChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string | null;
  agentMemberRoleIds?: string[];
  authorization?: AuthorizationInvocationContext;
  clientCaps?: string[];
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  pluginToolDenylist?: string[];
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
};

type LazyExecToolDefaults = {
  host?: string;
  allowBackground?: boolean;
  node?: string;
  elevated?: {
    enabled: boolean;
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable?: boolean;
    fullAccessBlockedReason?: string;
  };
};

type LazyExecToolPresentation = {
  description?: string;
  parameters?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  const createLazyExecToolMock = vi.fn(
    (_defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) => ({
      ...makeTool("exec"),
      description: presentation?.description ?? "exec tool",
      parameters: presentation?.parameters ?? { type: "object", properties: {} },
    }),
  );
  return {
    makeTool,
    createLazyExecToolMock,
    getLoadedChannelPluginMock: vi.fn(),
    createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("sessions_spawn"),
      makeTool("cron"),
      makeTool("gateway"),
      makeTool("nodes"),
    ]),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (channel: string) => hoisted.getLoadedChannelPluginMock(channel),
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: (defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) =>
    hoisted.createLazyExecToolMock(defaults, presentation),
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
    hoisted.createLazyExecToolMock.mockClear();
    hoisted.getLoadedChannelPluginMock.mockReset();
  });

  function readCreateToolsArgs(index = 0): CreateOpenClawToolsArg {
    const args = hoisted.createOpenClawToolsMock.mock.calls[index]?.[0];
    if (!args || typeof args !== "object") {
      throw new Error("expected createOpenClawTools args");
    }
    return args;
  }

  it("passes gateway client capabilities into tool construction", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      clientCaps: ["tool-events", "inline-widgets"],
    });

    expect(readCreateToolsArgs().clientCaps).toEqual(["tool-events", "inline-widgets"]);
  });

  it("filters loopback dedup exclusions without inheriting policy denies", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      excludeToolNames: ["read", "apply_patch"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual([]);
    expect(args.inheritedToolDenylist).toEqual([]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", () => {
    const ownerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });
    const nonOwnerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: false,
    });

    expect(ownerResult.tools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    expect(nonOwnerResult.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs(1);
    expect(args.pluginToolDenylist).toEqual([
      "cron",
      "gateway",
      "sessions",
      "screen",
      "terminal",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "nodes",
      "computer",
      "openclaw",
    ]);
    expect(args.inheritedToolDenylist).toEqual([
      "cron",
      "gateway",
      "sessions",
      "screen",
      "terminal",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "nodes",
      "computer",
      "openclaw",
    ]);
  });

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", () => {
    resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { deny: ["exec"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      excludeToolNames: ["read", "apply_patch"],
    });

    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual(["exec"]);
    expect(args.inheritedToolDenylist).toEqual(["exec"]);
  });

  it("adds a synchronous node-forced exec tool to allowed owner loopback scopes", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "ask",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });

    expect(result.tools.map((tool) => tool.name).filter((name) => name === "exec")).toEqual([
      "exec",
    ]);
    expect(hoisted.createLazyExecToolMock).toHaveBeenCalledOnce();
    expect(hoisted.createLazyExecToolMock.mock.calls[0]?.[0]).toMatchObject({
      host: "node",
      allowBackground: false,
      elevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "ask",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
    const presentation = hoisted.createLazyExecToolMock.mock.calls[0]?.[1];
    expect(presentation?.description).toContain("node-only");
    const schemaProperties = presentation?.parameters?.properties;
    expect(
      Object.keys(schemaProperties && typeof schemaProperties === "object" ? schemaProperties : {}),
    ).toEqual(["command", "workdir", "env", "timeout", "host", "node"]);
    const hostSchema = (
      schemaProperties && typeof schemaProperties === "object"
        ? (schemaProperties as Record<string, unknown>).host
        : undefined
    ) as { enum?: unknown } | undefined;
    expect(hostSchema?.enum).toEqual(["node"]);
  });

  it("omits all exec variants when host policy forbids node execution", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const gatewayOnly = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      execSession: { execHost: "gateway" },
    });
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const turnOverrideGateway = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      execSession: { execHost: "node" },
      execOverrides: { host: "gateway" },
    });
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const sandboxAuto = resolveGatewayScopedTools({
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(gatewayOnly.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(turnOverrideGateway.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(sandboxAuto.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("uses the runtime policy key for non-main sandbox classification", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:discord:default:direct:peer-42",
      agentId: "main",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("uses the explicit agent identity when a session key is an alias", () => {
    const cfg = {
      agents: {
        list: [{ id: "worker", tools: { deny: ["exec"] } }],
      },
    } as OpenClawConfig;
    const defaultAgent = resolveGatewayScopedTools({
      cfg,
      sessionKey: "main",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });
    const worker = resolveGatewayScopedTools({
      cfg,
      sessionKey: "main",
      agentId: "worker",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(defaultAgent.tools.map((tool) => tool.name)).toContain("exec");
    expect(worker.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs(1)).toMatchObject({ requesterAgentIdOverride: "worker" });
  });

  it("does not honor the internal node-exec flag on HTTP surfaces", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "http",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("filters node exec through the existing gateway deny policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: { gateway: { tools: { deny: ["exec"] } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
  });

  it("applies the node-originated message provider policy before gateway policy", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("canvas"),
      hoisted.makeTool("web_search"),
      hoisted.makeTool("exec"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:node:request:test",
      surface: "loopback",
      senderIsOwner: true,
      messageProvider: "node",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["canvas", "web_search"]);
    expect(hoisted.createLazyExecToolMock).toHaveBeenCalledOnce();
  });

  it("filters node exec through immutable sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "id:blocked-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("uses sender authority for requester policy while preserving transport routing", () => {
    const authorization: AuthorizationInvocationContext = {
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "canonical-account",
        senderId: "canonical-sender",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers", "reviewers"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:dev",
      runId: "run-canonical",
      trigger: "user",
    };
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "channel:discord:canonical-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      authorization,
      requesterIdentitySource: "authority",
      senderIsOwner: true,
      messageProvider: "telegram",
      accountId: "route-account",
      channelContext: {
        sender: { id: "legacy-sender" },
        chat: { id: "route-chat" },
      },
      senderName: "Legacy Name",
      senderUsername: "legacy-user",
      senderE164: "+15550001111",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    const args = readCreateToolsArgs();
    expect(args).toMatchObject({
      agentChannel: "telegram",
      agentAccountId: "route-account",
      senderIsOwner: false,
      requesterSenderId: "canonical-sender",
      agentMemberRoleIds: ["maintainers", "reviewers"],
      authorization: {
        principal: authorization.principal,
        agentId: "main",
        sessionKey: "agent:main:discord:channel:dev",
      },
    });
  });

  it("uses issued sender authority despite a stale legacy requester hint", () => {
    const authorization: AuthorizationInvocationContext = {
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: "canonical-account",
        senderId: "canonical-sender",
        roleIds: ["maintainers"],
      }),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:dev",
      trigger: "user",
    };
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "channel:discord:canonical-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      authorization,
      requesterIdentitySource: "legacy",
      senderIsOwner: true,
      messageProvider: "discord",
      accountId: "canonical-account",
      channelContext: { sender: { id: "legacy-owner" } },
      senderName: "Legacy Owner",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(result.tools.map((tool) => tool.name)).not.toContain("gateway");
    expect(readCreateToolsArgs()).toMatchObject({
      senderIsOwner: false,
      requesterSenderId: "canonical-sender",
      agentMemberRoleIds: ["maintainers"],
      authorization: { principal: authorization.principal },
    });
  });

  it("keeps explicitly legacy sender selectors separate from unknown authority", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "channel:discord:legacy-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      authorization: {
        principal: { kind: "unknown", provider: "discord", accountId: "canonical-account" },
        agentId: "main",
        sessionKey: "agent:main:discord:channel:dev",
        trigger: "mcp",
      },
      requesterIdentitySource: "legacy",
      senderIsOwner: true,
      messageProvider: "discord",
      accountId: "canonical-account",
      channelContext: { sender: { id: "legacy-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(result.tools.map((tool) => tool.name)).not.toContain("gateway");
    expect(readCreateToolsArgs()).toMatchObject({
      senderIsOwner: false,
      requesterSenderId: "legacy-sender",
      authorization: { principal: { kind: "unknown" } },
    });
    expect(readCreateToolsArgs().agentMemberRoleIds).toBeUndefined();
  });

  it.each([
    {
      policyKey: "name:Ada Lovelace",
      aliasInput: { senderName: " Ada Lovelace " },
      forgedField: "senderName",
      forgedValue: "Forged User",
      forgedPolicyKey: "name:Forged User",
    },
    {
      policyKey: "username:ada",
      aliasInput: { senderUsername: " @Ada " },
      forgedField: "senderUsername",
      forgedValue: "forged-user",
      forgedPolicyKey: "username:forged-user",
    },
    {
      policyKey: "e164:+15550001111",
      aliasInput: { senderE164: " +15550001111 " },
      forgedField: "senderE164",
      forgedValue: "+15559999999",
      forgedPolicyKey: "e164:+15559999999",
    },
  ] as const)(
    "uses issued $forgedField alias and ignores the legacy field",
    ({ policyKey, aliasInput, forgedField, forgedValue, forgedPolicyKey }) => {
      const result = resolveGatewayScopedTools({
        cfg: {
          tools: {
            toolsBySender: {
              [policyKey]: { deny: ["exec"] },
              [forgedPolicyKey]: { deny: ["read"] },
            },
          },
        } as OpenClawConfig,
        sessionKey: "agent:main:discord:channel:dev",
        surface: "loopback",
        authorization: {
          principal: createAuthorizationPrincipal({
            provider: "discord",
            accountId: "canonical-account",
            senderId: "canonical-sender",
            ...aliasInput,
          }),
          agentId: "main",
          sessionKey: "agent:main:discord:channel:dev",
          trigger: "user",
        },
        requesterIdentitySource: "authority",
        messageProvider: "discord",
        accountId: "canonical-account",
        channelContext: { sender: { id: "forged-sender" } },
        includeNodeExecTool: true,
        [forgedField]: forgedValue,
      });

      expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
      expect(result.tools.map((tool) => tool.name)).toContain("read");
      expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
      expect(readCreateToolsArgs().pluginToolDenylist).not.toContain("read");
    },
  );

  it("fails closed for cross-route group sender matching without changing the route channel", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        channels: {
          telegram: {
            groups: {
              dev: {
                toolsBySender: {
                  "channel:discord:canonical-sender": { deny: ["exec"] },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:dev",
      surface: "loopback",
      authorization: {
        principal: {
          kind: "sender",
          provider: "discord",
          senderId: "canonical-sender",
          senderIsOwner: false,
        },
        sessionKey: "agent:main:telegram:group:dev",
        trigger: "user",
      },
      requesterIdentitySource: "authority",
      messageProvider: "telegram",
      groupId: "dev",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().agentChannel).toBe("telegram");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("*");
  });

  it("uses operator ownership without treating legacy sender hints as requester identity", () => {
    const authorization: AuthorizationInvocationContext = {
      principal: {
        kind: "operator",
        scopes: ["operator.admin"],
        isOwner: true,
      },
      sessionKey: "agent:main:main",
      trigger: "gateway",
    };
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "*": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
      authorization,
      requesterIdentitySource: "legacy",
      senderIsOwner: false,
      messageProvider: "webchat",
      accountId: "route-account",
      channelContext: { sender: { id: "legacy-sender" } },
      senderName: "Legacy Name",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs()).toMatchObject({
      agentChannel: "webchat",
      agentAccountId: "route-account",
      senderIsOwner: true,
      authorization: {
        principal: authorization.principal,
        sessionKey: "agent:main:main",
      },
    });
    expect(readCreateToolsArgs().requesterSenderId).toBeUndefined();
    expect(readCreateToolsArgs().agentMemberRoleIds).toBeUndefined();
  });

  it.each([
    {
      label: "service",
      principal: { kind: "service", serviceId: "scheduler" } as const,
      requesterIdentitySource: "legacy" as const,
    },
    {
      label: "unknown",
      principal: {
        kind: "unknown",
        provider: "discord",
        accountId: "unknown-account",
      } as const,
      requesterIdentitySource: "authority" as const,
    },
  ])(
    "fails closed for $label authority despite legacy owner hints",
    ({ principal, requesterIdentitySource }) => {
      const result = resolveGatewayScopedTools({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        surface: "loopback",
        authorization: { principal, sessionKey: "agent:main:main", trigger: "internal" },
        requesterIdentitySource,
        senderIsOwner: true,
        messageProvider: "discord",
        accountId: "route-account",
        channelContext: { sender: { id: "legacy-owner" } },
        senderName: "Legacy Owner",
      });

      expect(result.tools.map((tool) => tool.name)).not.toContain("gateway");
      expect(readCreateToolsArgs()).toMatchObject({
        agentChannel: "discord",
        agentAccountId: "route-account",
        senderIsOwner: false,
        authorization: { principal },
      });
      expect(readCreateToolsArgs().requesterSenderId).toBeUndefined();
      expect(readCreateToolsArgs().agentMemberRoleIds).toBeUndefined();
    },
  );

  it("filters node exec through plugin group policy bound to group labels", () => {
    const resolveToolPolicy = vi.fn(
      (params: { groupChannel?: string | null; groupSpace?: string | null }) =>
        params.groupChannel === "ops" && params.groupSpace === "guild-blocked"
          ? { deny: ["exec"] }
          : undefined,
    );
    hoisted.getLoadedChannelPluginMock.mockReturnValue({
      groups: { resolveToolPolicy },
    });

    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:child",
      spawnedBy: "agent:main:discord:channel:bound",
      groupId: "bound",
      groupChannel: "ops",
      groupSpace: "guild-blocked",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      includeNodeExecTool: true,
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

  it.each([
    { policyKey: "name:Guest Name", field: "senderName", value: "Guest Name" },
    { policyKey: "username:guest-user", field: "senderUsername", value: "guest-user" },
    { policyKey: "e164:+15550001111", field: "senderE164", value: "+15550001111" },
  ] as const)("filters node exec through $field sender policy", ({ policyKey, field, value }) => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            [policyKey]: { deny: ["exec"] },
            "*": {},
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      includeNodeExecTool: true,
      [field]: value,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it.each([
    { label: "a non-owner external sender", messageProvider: "discord", senderIsOwner: false },
    { label: "an owner on an external channel", messageProvider: "discord", senderIsOwner: true },
  ])(
    "filters node exec through wildcard sender policy for $label",
    ({ messageProvider, senderIsOwner }) => {
      const result = resolveGatewayScopedTools({
        cfg: {
          tools: {
            toolsBySender: {
              "*": { deny: ["exec"] },
            },
          },
        } as OpenClawConfig,
        sessionKey: "agent:main:discord:channel:dev",
        surface: "loopback",
        senderIsOwner,
        messageProvider,
        includeNodeExecTool: true,
      });

      expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
      expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
    },
  );

  it("preserves owner WebChat access from wildcard sender policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "*": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
      senderIsOwner: true,
      messageProvider: "webchat",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).not.toContain("exec");
  });

  it("filters node exec through global provider policy", () => {
    const cfg = {
      tools: {
        byProvider: {
          anthropic: { deny: ["exec"] },
        },
      },
    } as OpenClawConfig;
    const blocked = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const allowed = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "openai",
      modelId: "gpt-5.5",
    });

    expect(blocked.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(allowed.tools.map((tool) => tool.name)).toContain("exec");
  });

  it("filters node exec through agent model policy", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              byProvider: {
                "anthropic/claude-opus-4-7": { deny: ["exec"] },
              },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const blocked = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const allowed = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(blocked.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(allowed.tools.map((tool) => tool.name)).toContain("exec");
  });

  it("filters node exec through group sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        channels: {
          telegram: {
            groups: {
              dev: {
                toolsBySender: {
                  "id:blocked-sender": { deny: ["exec"] },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "telegram",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("does not inherit node-only exec as a generic child or cron capability", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { allow: ["exec", "sessions_spawn", "cron"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().inheritedToolAllowlist).not.toContain("exec");
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).not.toContainEqual({ name: "exec" });
  });

  it("passes sandbox context and inherited sandbox denies into loopback tools", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["cron"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs();
    expect(args.sandboxed).toBe(true);
    expect(args.pluginToolDenylist).toEqual(["cron"]);
    expect(args.inheritedToolDenylist).toEqual(["cron"]);
  });

  it("passes final filtered tool surface to gateway cron jobs", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("cron"),
      hoisted.makeTool("exec"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "cron" },
    ]);
  });
});
