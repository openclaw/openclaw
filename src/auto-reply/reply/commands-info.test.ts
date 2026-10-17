import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import {
  handleExportSessionCommand,
  handleExportTrajectoryCommand,
  handleSkillCommandUsage,
  handleStatusCommand,
  handleToolsCommand as handleToolsCommandImpl,
} from "./commands-info.js";
import { buildStatusPluginsReply, buildStatusReply } from "./commands-status.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleWhoamiCommand } from "./commands-whoami.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const buildExportTrajectoryCommandReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "exported" })),
);
const buildExportSessionReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "session exported" })),
);
const prepareSkillCommandsForAgentsMock = vi.hoisted(() => vi.fn(async () => []));
const demoSkills = [{ name: "demo_skill", skillName: "demo-skill", description: "Demo skill" }];
const buildCommandsMessagePaginatedMock = vi.hoisted(() =>
  vi.fn(() => ({ text: "/commands", currentPage: 1, totalPages: 1 })),
);

vi.mock("./commands-export-trajectory.js", () => ({
  buildExportTrajectoryCommandReply: buildExportTrajectoryCommandReplyMock,
}));

vi.mock("./commands-export-session.js", () => ({
  buildExportSessionReply: buildExportSessionReplyMock,
}));

vi.mock("./commands-status.js", () => ({
  buildStatusPluginsReply: vi.fn(async () => ({ text: "plugins status reply" })),
  buildStatusReply: vi.fn(async () => ({ text: "status reply" })),
}));

vi.mock("../../skills/discovery/chat-commands.js", async () => {
  const actual = await vi.importActual<typeof import("../../skills/discovery/chat-commands.js")>(
    "../../skills/discovery/chat-commands.js",
  );
  return {
    ...actual,
    prepareSkillCommandsForAgents: prepareSkillCommandsForAgentsMock,
  };
});

vi.mock("../status.js", async () => {
  const actual = await vi.importActual<typeof import("../status.js")>("../status.js");
  return {
    ...actual,
    buildCommandsMessagePaginated: buildCommandsMessagePaginatedMock,
  };
});

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  expect(mock.mock.calls).toHaveLength(1);
  const [arg] = mock.mock.calls.at(0) ?? [];
  if (!arg) {
    throw new Error(`expected ${label} to receive arguments`);
  }
  return arg;
}

function buildInfoParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = { commands: { text: true } },
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const params = buildCommandTestParams(commandBodyNormalized, cfg, ctxOverrides);
  Object.assign(params.command, {
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "12345",
    channel: "whatsapp",
    channelId: "whatsapp",
    surface: "whatsapp",
    ownerList: [],
    from: "12345",
    to: "bot",
  });
  params.sessionKey = "agent:main:whatsapp:direct:12345";
  params.directives = {};
  return params;
}

describe("info command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildExportSessionReplyMock.mockResolvedValue({ text: "session exported" });
    buildExportTrajectoryCommandReplyMock.mockResolvedValue({ text: "exported" });
    buildCommandsMessagePaginatedMock.mockReturnValue({
      text: "/commands",
      currentPage: 1,
      totalPages: 1,
    });
  });

  it("blocks authorized non-owners from exporting a session", async () => {
    const params = buildInfoParams("/export-session");
    params.command.senderIsOwner = false;
    expect(await handleExportSessionCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
    expect(buildExportSessionReplyMock).not.toHaveBeenCalled();
  });

  it("allows the owner to export a session", async () => {
    const params = buildInfoParams("/export-session");

    const result = await handleExportSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "session exported" },
    });
    expect(buildExportSessionReplyMock).toHaveBeenCalledWith(params);
  });

  it("ignores trajectory export requests from unauthorized senders", async () => {
    const params = buildInfoParams("/export-trajectory");
    params.command.isAuthorizedSender = false;

    const result = await handleExportTrajectoryCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(buildExportTrajectoryCommandReplyMock).not.toHaveBeenCalled();
  });

  it("blocks authorized non-owners from exporting trajectory bundles", async () => {
    const params = buildInfoParams("/export-trajectory");
    params.command.senderIsOwner = false;

    const result = await handleExportTrajectoryCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
    expect(buildExportTrajectoryCommandReplyMock).not.toHaveBeenCalled();
  });

  it("returns usage for bare /skill without continuing to the agent", async () => {
    const params = buildInfoParams("/skill");
    params.skillCommands = demoSkills;

    const result = await handleSkillCommandUsage(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /skill <name> [input]");
    expect(result?.reply?.text).toContain("Available: demo-skill");
  });

  it("loads skills when named /skill receives an empty precomputed command list", async () => {
    const params = buildInfoParams("/skill demo_skill input");
    params.skillCommands = [];
    params.loadSkillCommands = vi.fn(async () => demoSkills);

    const result = await handleSkillCommandUsage(params, true);

    expect(result).toBeNull();
    expect(params.loadSkillCommands).toHaveBeenCalledOnce();
    expect(prepareSkillCommandsForAgentsMock).not.toHaveBeenCalled();
  });

  it("keeps an empty precomputed /skill command list authoritative without a loader", async () => {
    const params = buildInfoParams("/skill demo_skill input");
    params.skillCommands = [];

    const result = await handleSkillCommandUsage(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Unknown skill: demo_skill");
    expect(prepareSkillCommandsForAgentsMock).not.toHaveBeenCalled();
  });

  it("uses the canonical command sender identity for /whoami AllowFrom", async () => {
    const params = buildInfoParams("/whoami", buildConfig(), {
      SenderId: "123@lid",
      SenderUsername: "TestUser",
      SenderE164: "+15551234567",
      ChatType: "direct",
    });
    params.command.senderId = "+15551234567";

    const result = await handleWhoamiCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: whatsapp");
    expect(result?.reply?.text).toContain("Username: @TestUser");
    expect(result?.reply?.text).toContain("User id: 123@lid");
    expect(result?.reply?.text).toContain("AllowFrom: +15551234567");
  });

  it("preserves the shared session store path when routing /status", async () => {
    const params = buildInfoParams("/status", buildConfig());
    params.storePath = "/tmp/target-session-store.json";
    params.resolvedFastMode = true;

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);
    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams).toMatchObject({
      storePath: "/tmp/target-session-store.json",
      resolvedFastMode: true,
    });
  });

  it("prefers the target session entry when routing /status", async () => {
    const params = buildInfoParams("/status", buildConfig());
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      parentSessionKey: "wrapper-parent",
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      "agent:main:whatsapp:direct:12345": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        parentSessionKey: "target-parent",
      },
    };

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);
    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams.sessionEntry?.sessionId).toBe("target-session");
    expect(statusReplyParams.sessionEntry?.parentSessionKey).toBe("target-parent");
    expect(statusReplyParams.parentSessionKey).toBe("target-parent");
  });

  it("routes /status plugins to the plugin health summary", async () => {
    const params = buildInfoParams("/status plugins", buildConfig());

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult).toEqual({
      shouldContinue: false,
      reply: { text: "plugins status reply" },
    });
    expect(buildStatusPluginsReply).toHaveBeenCalledWith({
      cfg: params.cfg,
      command: params.command,
      workspaceDir: params.workspaceDir,
    });
    expect(buildStatusReply).not.toHaveBeenCalled();
  });

  it("uses the canonical target session agent when listing /commands", async () => {
    const { handleCommandsListCommand } = await import("./commands-info.js");
    const params = buildInfoParams("/commands", buildConfig());
    params.agentId = "target";
    params.sessionKey = "agent:target:whatsapp:direct:12345";

    const result = await handleCommandsListCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const listParams = firstMockArg(
      prepareSkillCommandsForAgentsMock,
      "prepareSkillCommandsForAgents",
    ) as { agentIds?: string[] };
    expect(listParams.agentIds).toEqual(["target"]);
  });
});

function makeDefaultInventory(): EffectiveToolInventoryResult {
  function group(
    source: "core" | "plugin",
    label: string,
    id: string,
    toolLabel: string,
    description: string,
    pluginId?: string,
  ) {
    return {
      id: source,
      label,
      source,
      tools: [
        {
          id,
          label: toolLabel,
          description,
          rawDescription: description,
          source,
          ...(pluginId ? { pluginId } : {}),
        },
      ],
    };
  }
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      group("core", "Built-in tools", "exec", "Exec", "Run shell commands"),
      group(
        "plugin",
        "Connected tools",
        "docs_lookup",
        "Docs Lookup",
        "Search internal documentation",
        "docs",
      ),
    ],
  };
}

const toolsTestState = vi.hoisted(() => {
  const defaultResolveTools = (): EffectiveToolInventoryResult => makeDefaultInventory();

  return {
    releaseRuntimeModel: vi.fn(async () => {}),
    resolveToolsMock: vi.fn((..._args: unknown[]) => defaultResolveTools()),
    resolveRuntimeModelContextMock: vi.fn(async (_params: unknown) => ({})),
    threadingContext: {
      currentChannelId: "channel-123",
      currentMessageId: "message-456",
    },
    replyToMode: "all" as const,
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: (...args: unknown[]) => toolsTestState.resolveToolsMock(...args),
  acquireEffectiveToolInventoryRuntimeModelContext: async (params: unknown) => {
    const context = await toolsTestState.resolveRuntimeModelContextMock(params);
    return {
      run: <T>(project: (value: typeof context) => T): T => project(context),
      [Symbol.asyncDispose]: toolsTestState.releaseRuntimeModel,
    };
  },
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildThreadingToolContext: () => toolsTestState.threadingContext,
}));

vi.mock("./reply-threading.js", () => ({
  resolveReplyToMode: () => toolsTestState.replyToMode,
}));

function buildConfig() {
  return {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
}

function toolsParams(command = "/tools", cfg = buildConfig()) {
  return buildCommandTestParams(command, cfg);
}

function expectText(text: string | undefined, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}

function resolveToolsArg(resolveToolsMock: { mock: { calls: unknown[][] } }, index = 0) {
  const [arg] = resolveToolsMock.mock.calls[index] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected resolve tools call ${index + 1}`);
  }
  return arg as Record<string, unknown>;
}

describe("handleToolsCommand", () => {
  beforeEach(() => {
    toolsTestState.releaseRuntimeModel.mockClear();
    toolsTestState.resolveToolsMock.mockReset().mockImplementation(() => makeDefaultInventory());
    toolsTestState.resolveRuntimeModelContextMock.mockReset();
    toolsTestState.resolveRuntimeModelContextMock.mockResolvedValue({});
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("renders a product-facing tool list", async () => {
    const params = toolsParams();
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      From: "telegram:group:abc123",
      GroupChannel: "#ops",
      GroupSpace: "workspace-1",
      SenderName: "User Name",
      SenderUsername: "user_name",
      SenderE164: "+1000",
      MessageThreadId: 99,
      AccountId: "acct-1",
      Provider: "telegram",
      ChatType: "group",
    };

    const result = await handleToolsCommandImpl(params, true);

    expectText(
      result?.reply?.text,
      "Available tools",
      "Profile: coding",
      "Built-in tools",
      "exec",
      "Connected tools",
      "docs_lookup (docs)",
    );
    expect(result?.reply?.text).not.toContain("unavailable right now");
    const toolsArg = resolveToolsArg(toolsTestState.resolveToolsMock);
    expect(toolsArg).not.toHaveProperty("senderIsOwner");
    expect(toolsArg).toMatchObject({
      senderId: undefined,
      senderName: "User Name",
      senderUsername: "user_name",
      senderE164: "+1000",
      accountId: "acct-1",
      currentChannelId: "channel-123",
      currentThreadTs: "99",
      currentMessageId: "message-456",
      groupId: "abc123",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      replyToMode: "all",
    });
    expect(toolsTestState.releaseRuntimeModel).toHaveBeenCalledOnce();
  });

  it("returns usage when arguments are provided", async () => {
    const result = await handleToolsCommandImpl(toolsParams("/tools extra"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /tools [compact|verbose]" },
    });
  });

  it("does not synthesize group ids for direct-chat sender ids", async () => {
    const params = toolsParams();
    params.ctx = {
      ...params.ctx,
      From: "telegram:8231046597",
      Provider: "telegram",
      ChatType: "dm",
    };

    await handleToolsCommandImpl(params, true);

    expect(resolveToolsArg(toolsTestState.resolveToolsMock).groupId).toBeUndefined();
  });

  it("prefers the target session entry for tool inventory group metadata", async () => {
    const params = toolsParams();
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      groupId: "wrapper-group",
      groupChannel: "#wrapper",
      space: "wrapper-space",
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        groupId: "target-group",
        groupChannel: "#target",
        space: "target-space",
      },
    };
    params.ctx = {
      ...params.ctx,
      From: "telegram:group:abc123",
      Provider: "telegram",
      Surface: "telegram",
      GroupChannel: "#ctx",
      GroupSpace: "ctx-space",
    };

    await handleToolsCommandImpl(params, true);

    const toolsArg = resolveToolsArg(toolsTestState.resolveToolsMock);
    expect(toolsArg.groupId).toBe("target-group");
    expect(toolsArg.groupChannel).toBe("#target");
    expect(toolsArg.groupSpace).toBe("target-space");
  });

  it("renders the detailed tool list in verbose mode", async () => {
    const result = await handleToolsCommandImpl(toolsParams("/tools verbose"), true);

    expectText(
      result?.reply?.text,
      "What this agent can use right now:",
      "Profile: coding",
      "Exec - Run shell commands",
      "Docs Lookup - Search internal documentation",
    );
  });

  it("releases the model context when tools projection fails", async () => {
    toolsTestState.resolveToolsMock.mockImplementation(() => {
      expect(toolsTestState.releaseRuntimeModel).not.toHaveBeenCalled();
      throw new Error("inventory projection failed");
    });
    const result = await handleToolsCommandImpl(toolsParams(), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Couldn't load available tools right now. Try again in a moment." },
    });
    expect(toolsTestState.releaseRuntimeModel).toHaveBeenCalledOnce();
  });

  it("ignores unauthorized senders", async () => {
    const params = toolsParams();
    params.command = {
      ...params.command,
      isAuthorizedSender: false,
      senderId: "unauthorized",
    };

    const result = await handleToolsCommandImpl(params, true);

    expect(result).toEqual({ shouldContinue: false });
  });

  it("uses the configured default account when /tools omits AccountId", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "telegram",
              label: "Telegram",
              config: {
                listAccountIds: () => ["default", "work"],
                defaultAccountId: () => "work",
                resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
              },
            }),
          },
        },
      ]),
    );

    const params = toolsParams("/tools", {
      commands: { text: true },
      channels: { telegram: { defaultAccount: "work" } },
    } as OpenClawConfig);
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      AccountId: undefined,
    };
    params.command = {
      ...params.command,
      channel: "telegram",
    };

    await handleToolsCommandImpl(params, true);

    expect(resolveToolsArg(toolsTestState.resolveToolsMock).accountId).toBe("work");
  });
});
