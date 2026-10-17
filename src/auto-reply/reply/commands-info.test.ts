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

function expectCall(mock: { mock: { calls: unknown[][] } }, fields: object) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectReply(result: unknown, text: unknown) {
  expect(result).toEqual({ shouldContinue: false, reply: { text } });
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
  });

  it.each([
    ["session", handleExportSessionCommand, buildExportSessionReplyMock],
    ["trajectory", handleExportTrajectoryCommand, buildExportTrajectoryCommandReplyMock],
  ] as const)(
    "blocks authorized non-owners from exporting a %s",
    async (kind, handler, buildReply) => {
      const params = buildInfoParams(`/export-${kind}`);
      params.command.senderIsOwner = false;
      expectReply(await handler(params, true), expect.stringContaining("commands.ownerAllowFrom"));
      expect(buildReply).not.toHaveBeenCalled();
    },
  );

  it("allows the owner to export a session", async () => {
    const params = buildInfoParams("/export-session");

    const result = await handleExportSessionCommand(params, true);

    expectReply(result, "session exported");
    expect(buildExportSessionReplyMock).toHaveBeenCalledWith(params);
  });

  it("ignores trajectory export requests from unauthorized senders", async () => {
    const params = buildInfoParams("/export-trajectory");
    params.command.isAuthorizedSender = false;

    const result = await handleExportTrajectoryCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
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
    expectCall(buildStatusReply, {
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
    expectCall(buildStatusReply, {
      sessionEntry: expect.objectContaining({
        sessionId: "target-session",
        parentSessionKey: "target-parent",
      }),
      parentSessionKey: "target-parent",
    });
  });

  it("routes /status plugins to the plugin health summary", async () => {
    const params = buildInfoParams("/status plugins", buildConfig());

    const statusResult = await handleStatusCommand(params, true);

    expectReply(statusResult, "plugins status reply");
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
    expectCall(prepareSkillCommandsForAgentsMock, { agentIds: ["target"] });
  });
});

function makeDefaultInventory(): EffectiveToolInventoryResult {
  const groups = [
    ["core", "Built-in tools", "exec", "Exec", "Run shell commands", undefined],
    [
      "plugin",
      "Connected tools",
      "docs_lookup",
      "Docs Lookup",
      "Search internal documentation",
      "docs",
    ],
  ] as const;
  return {
    agentId: "main",
    profile: "coding",
    groups: groups.map(([source, label, id, toolLabel, description, pluginId]) => ({
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
    })),
  };
}

const toolsTestState = vi.hoisted(() => ({
  releaseRuntimeModel: vi.fn(async () => {}),
  resolveToolsMock: vi.fn((..._args: unknown[]) => makeDefaultInventory()),
  resolveRuntimeModelContextMock: vi.fn(async (_params: unknown) => ({})),
  threadingContext: {
    currentChannelId: "channel-123",
    currentMessageId: "message-456",
  },
  replyToMode: "all" as const,
}));

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
    Object.assign(params.ctx, {
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
    });

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
    expect(toolsTestState.resolveToolsMock.mock.calls[0]?.[0]).not.toHaveProperty("senderIsOwner");
    expectCall(toolsTestState.resolveToolsMock, {
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

    expectReply(result, "Usage: /tools [compact|verbose]");
  });

  it("does not synthesize group ids for direct-chat sender ids", async () => {
    const params = toolsParams();
    Object.assign(params.ctx, {
      From: "telegram:8231046597",
      Provider: "telegram",
      ChatType: "dm",
    });

    await handleToolsCommandImpl(params, true);

    expectCall(toolsTestState.resolveToolsMock, { groupId: undefined });
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
    Object.assign(params.ctx, {
      From: "telegram:group:abc123",
      Provider: "telegram",
      Surface: "telegram",
      GroupChannel: "#ctx",
      GroupSpace: "ctx-space",
    });

    await handleToolsCommandImpl(params, true);

    expectCall(toolsTestState.resolveToolsMock, {
      groupId: "target-group",
      groupChannel: "#target",
      groupSpace: "target-space",
    });
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
    expectReply(result, "Couldn't load available tools right now. Try again in a moment.");
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
          plugin: createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            config: {
              listAccountIds: () => ["default", "work"],
              defaultAccountId: () => "work",
              resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
            },
          }),
        },
      ]),
    );

    const params = toolsParams("/tools", {
      commands: { text: true },
      channels: { telegram: { defaultAccount: "work" } },
    } as OpenClawConfig);
    Object.assign(params.ctx, {
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      AccountId: undefined,
    });
    params.command.channel = "telegram";

    await handleToolsCommandImpl(params, true);

    expectCall(toolsTestState.resolveToolsMock, { accountId: "work" });
  });
});
