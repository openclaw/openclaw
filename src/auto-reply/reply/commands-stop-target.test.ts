import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { handleStopCommand } from "./commands-session-abort.js";
import "./commands-session-abort.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";

const abortEmbeddedAgentRunMock = vi.hoisted(() => vi.fn());
const createInternalHookEventMock = vi.hoisted(() => vi.fn(() => ({})));
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn(async () => true));
const resolveSessionIdMock = vi.hoisted(() => vi.fn(() => undefined));
const stopSubagentsForRequesterMock = vi.hoisted(() => vi.fn(() => ({ stopped: 0 })));
const abortSessionRunTargetMock = vi.hoisted(() => vi.fn());
const clearSessionQueuesMock = vi.mocked(clearSessionQueues);

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: createInternalHookEventMock,
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort.js", () => ({
  abortSessionRunTarget: abortSessionRunTargetMock,
  formatAbortReplyText: vi.fn(() => "⚙️ Agent was aborted."),
  isAbortTrigger: vi.fn(() => false),
  resolveSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: undefined })),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: stopSubagentsForRequesterMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    resolveSessionId: resolveSessionIdMock,
  },
}));

const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
  const values: string[] = [];
  for (const entry of allowFrom) {
    const value = String(entry).trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
};

let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function registerOwnerEnforcingTelegramPlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: { deliveryMode: "direct" },
          }),
          commands: { enforceOwnerForCommands: true },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            resolveAllowFrom: () => ["*"],
            formatAllowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
}

function buildStopParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "text",
      CommandTargetSessionKey: "agent:target:telegram:direct:123",
      ReplyToId: "42",
    },
    command: {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    sessionKey: "agent:main:telegram:slash-session",
    sessionEntry: {
      sessionId: "wrapper-session-id",
      updatedAt: Date.now(),
    },
    sessionStore: {
      "agent:target:telegram:direct:123": {
        sessionId: "target-session-id",
        updatedAt: Date.now(),
        messageWorkTargets: [
          {
            channel: "telegram",
            to: "123",
            messageId: "42",
            recordedAt: Date.now(),
          },
        ],
      },
    },
    storePath: "/tmp/sessions.json",
  } as unknown as HandleCommandsParams;
}

describe("handleStopCommand target fallback", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
    clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
    persistAbortTargetEntryMock.mockResolvedValue(true);
    abortSessionRunTargetMock.mockReturnValue(true);
  });

  afterEach(() => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("does not fall back to the wrapper session when a distinct target session is missing from store", async () => {
    const params = buildStopParams();

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted." },
    });
    expect(abortSessionRunTargetMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalledWith("wrapper-session-id");
    const [[persistAbortTargetParams]] = persistAbortTargetEntryMock.mock.calls as unknown as Array<
      [
        {
          key?: string;
          entry?: unknown;
          sessionStore?: unknown;
          storePath?: string;
        },
      ]
    >;
    expect(persistAbortTargetParams?.key).toBe("agent:target:telegram:direct:123");
    expect(persistAbortTargetParams?.entry).toBeUndefined();
    expect(persistAbortTargetParams?.sessionStore).toBe(params.sessionStore);
    expect(persistAbortTargetParams?.storePath).toBe("/tmp/sessions.json");
    const [[stopSubagentsParams]] = stopSubagentsForRequesterMock.mock.calls as unknown as Array<
      [{ cfg?: unknown; requesterSessionKey?: string }]
    >;
    expect(stopSubagentsParams?.cfg).toBe(params.cfg);
    expect(stopSubagentsParams?.requesterSessionKey).toBe("agent:target:telegram:direct:123");
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "command",
      "stop",
      "agent:target:telegram:direct:123",
      {
        sessionEntry: undefined,
        sessionId: undefined,
        commandSource: "telegram",
        senderId: "owner",
      },
    );
  });

  it("keeps bare Telegram stop commands targeting the current session", async () => {
    const params = buildStopParams();
    delete params.ctx.ReplyToId;
    params.sessionStore = {
      "agent:target:telegram:direct:123": {
        sessionId: "target-session-id",
        updatedAt: Date.now(),
      },
    };

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted." },
    });
    expect(abortSessionRunTargetMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(persistAbortTargetEntryMock).toHaveBeenCalled();
    expect(createInternalHookEventMock).toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).toHaveBeenCalledWith({
      cfg: params.cfg,
      requesterSessionKey: "agent:target:telegram:direct:123",
    });
  });

  it("requires Telegram cancel commands to be replies", async () => {
    const params = buildStopParams();
    params.command.commandBodyNormalized = "/cancel";
    params.command.rawBodyNormalized = "/cancel";
    delete params.ctx.ReplyToId;

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Reply to a message with /stop or /cancel to stop work for that message." },
    });
    expect(abortSessionRunTargetMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });

  it("does not cancel Telegram work when the replied-to message has no active target", async () => {
    const params = buildStopParams();
    params.sessionStore = {};

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "No active work was found for the replied-to message." },
    });
    expect(abortSessionRunTargetMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
  });

  it("treats reply-scoped Telegram /cancel as a stop alias", async () => {
    const params = buildStopParams();
    params.command.commandBodyNormalized = "/cancel";
    params.command.rawBodyNormalized = "/cancel";

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted." },
    });
    expect(abortSessionRunTargetMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
  });

  it("does not treat non-Telegram /cancel as a shared stop alias", async () => {
    const params = buildStopParams();
    params.ctx = {
      Provider: "discord",
      Surface: "discord",
      CommandSource: "text",
      CommandTargetSessionKey: "agent:target:discord:channel:123",
    } as MsgContext;
    params.command.commandBodyNormalized = "/cancel";
    params.command.rawBodyNormalized = "/cancel";
    params.command.channel = "discord";
    params.command.channelId = "discord";
    params.command.surface = "discord";

    const result = await handleStopCommand(params, true);

    expect(result).toBeNull();
    expect(abortSessionRunTargetMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });

  it("does not clear queues when the replied-to target has already finished", async () => {
    const params = buildStopParams();
    abortSessionRunTargetMock.mockReturnValue(false);

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "No active work is still running for the replied-to message." },
    });
    expect(abortSessionRunTargetMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });

  it("rejects native stop commands from non-owner senders when the plugin enforces owner-only commands", async () => {
    registerOwnerEnforcingTelegramPlugin();
    const params = buildStopParams();
    const cfg = {
      commands: { text: true, allowFrom: { "*": ["*"] } },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:999",
      SenderId: "999",
      CommandSource: "native",
      CommandTargetSessionKey: "agent:target:telegram:direct:123",
      ReplyToId: "42",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    params.cfg = cfg;
    params.ctx = ctx;
    params.command.senderId = auth.senderId;
    params.command.senderIsOwner = auth.senderIsOwner;
    params.command.isAuthorizedSender = auth.isAuthorizedSender;
    params.command.from = auth.from;
    params.command.to = auth.to;

    const result = await handleStopCommand(params, true);

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
    expect(abortSessionRunTargetMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });
});
