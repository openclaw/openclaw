// Tests stop command target resolution across active sessions and channel routes.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { maybeAdmitSupervisedRootTask } from "../../tasks/supervised-task.admission.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { handleAbortTrigger, handleStopCommand } from "./commands-session-abort.js";
import type { resolveCommandSessionEntryForKey } from "./commands-session-store.js";
import type { HandleCommandsParams } from "./commands-types.js";
import "./commands-session-abort.test-support.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

const supervision = vi.hoisted(() => ({
  admit: vi.fn<typeof maybeAdmitSupervisedRootTask>(),
  session: vi.fn(),
}));
vi.mock("../../tasks/supervised-task.admission.js", () => ({
  maybeAdmitSupervisedRootTask: supervision.admit,
}));
vi.mock("../../tasks/supervised-task.root-source.js", () => ({
  bindSupervisedRootSource: (p: object) => p,
}));
vi.mock("../../gateway/session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: supervision.session,
}));
const abortEmbeddedAgentRunMock = vi.hoisted(() => vi.fn());
const createInternalHookEventMock = vi.hoisted(() => vi.fn(() => ({})));
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn(async () => true));
const resolveCommandSessionEntryForKeyMock = vi.hoisted(() =>
  vi.fn<typeof resolveCommandSessionEntryForKey>(() => ({ entry: undefined, key: undefined })),
);
const resolveSessionIdMock = vi.hoisted(() => vi.fn(() => undefined));
const stopSubagentsForRequesterMock = vi.hoisted(() =>
  vi.fn(async (params: { beforeKill?: () => Promise<boolean> }) => {
    await params.beforeKill?.();
    return { stopped: 0, failed: 0 };
  }),
);
const abortSessionRunTargetWithOutcomeMock = vi.hoisted(() =>
  vi.fn(() => ({ active: false, aborted: false })),
);
const formatAbortReplyTextMock = vi.hoisted(() => vi.fn(() => "⚙️ Agent was aborted."));

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
  abortSessionRunTargetWithOutcome: abortSessionRunTargetWithOutcomeMock,
  formatAbortReplyText: formatAbortReplyTextMock,
  isAbortTrigger: vi.fn((raw: string) => raw === "stop"),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: stopSubagentsForRequesterMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: resolveCommandSessionEntryForKeyMock,
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
    sessionStore: {},
    storePath: "/tmp/sessions.json",
  } as unknown as HandleCommandsParams;
}

describe("handleStopCommand target fallback", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: false, aborted: false });
    persistAbortTargetEntryMock.mockResolvedValue(true);
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
    expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalledWith("wrapper-session-id");
    const [persistAbortTargetParams] = expectDefined(
      (
        persistAbortTargetEntryMock.mock.calls as unknown as Array<
          [
            {
              key?: string;
              entry?: unknown;
              sessionStore?: unknown;
              storePath?: string;
            },
          ]
        >
      )[0],
      "(persistAbortTargetEntryMock.mock.calls as unknown as Array<\n        [\n          {\n            key?: string;\n            entry?: unknown;\n            sessionStore?: unknown;\n            storePath?: string;\n          },\n        ]\n      >)[0] test invariant",
    );
    expect(persistAbortTargetParams?.key).toBe("agent:target:telegram:direct:123");
    expect(persistAbortTargetParams?.entry).toBeUndefined();
    expect(persistAbortTargetParams?.sessionStore).toBe(params.sessionStore);
    expect(persistAbortTargetParams?.storePath).toBe("/tmp/sessions.json");
    const [stopSubagentsParams] = expectDefined(
      (
        stopSubagentsForRequesterMock.mock.calls as unknown as Array<
          [{ cfg?: unknown; requesterSessionKey?: string }]
        >
      )[0],
      "(stopSubagentsForRequesterMock.mock.calls as unknown as Array<\n        [{ cfg?: unknown; requesterSessionKey?: string }]\n      >)[0] test invariant",
    );
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

  it("reports a finalizing target without persisting abort state", async () => {
    const params = buildStopParams();
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: true, aborted: false });
    formatAbortReplyTextMock.mockReturnValue(
      "Agent reply is already finalizing and can no longer be aborted.",
    );

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
    });
    expect(formatAbortReplyTextMock).toHaveBeenCalledWith(0, "finalizing", 0);
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
  });

  it("surfaces child stop failures in the stop reply", async () => {
    const params = buildStopParams();
    stopSubagentsForRequesterMock.mockResolvedValueOnce({ stopped: 0, failed: 1 });
    formatAbortReplyTextMock.mockReturnValueOnce(
      "⚙️ Agent was aborted. One sub-agent could not be stopped. Retry /stop.",
    );

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚙️ Agent was aborted. One sub-agent could not be stopped. Retry /stop.",
      },
    });
    expect(formatAbortReplyTextMock).toHaveBeenCalledWith(0, undefined, 1);
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
    expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });
});

it.each([
  { raw: "/stop", enabled: true },
  { raw: "/stop@FixtureBot", enabled: true },
  { raw: "/stop", enabled: false },
  { raw: "/stop", enabled: undefined },
])(
  "stops the exact supervised target through canonical $raw with admission $enabled",
  async ({ raw, enabled }) => {
    supervision.admit.mockReset();
    formatAbortReplyTextMock.mockReturnValue("⚙️ Agent was aborted.");
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: false, aborted: false });
    const params = buildStopParams();
    params.command.rawBodyNormalized = raw;
    params.command.commandBodyNormalized = "/stop";
    params.agentId = "target";
    params.provider = "openai";
    params.model = "fixture";
    params.cfg.agents = {
      entries: {
        target:
          enabled === undefined
            ? {}
            : {
                taskSupervision: { enabled, policyFile: "/unused-policy.json" },
              },
      },
    };
    setChannelSourceTurnId(params.ctx, "accepted-stop-input");
    const target = { sessionId: "durable-session", updatedAt: 1000 };
    resolveCommandSessionEntryForKeyMock.mockReturnValue({
      entry: target,
      key: "agent:target:telegram:direct:123",
    });
    supervision.session.mockReturnValue({ entry: target });
    supervision.admit.mockImplementation(async (input) => {
      input.assertCurrent();
      expect(input.message).toBe("/stop");
      expect(input.source).toMatchObject({
        sessionId: "durable-session",
        sessionKey: "agent:target:telegram:direct:123",
        inputId: "accepted-stop-input",
      });
      expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
      return {
        kind: "handled",
        control: "cancel",
        replay: false,
        message: "Supervised task cancelled; earlier effects remain unknown.",
      };
    });
    abortSessionRunTargetWithOutcomeMock.mockClear();
    const result = await handleStopCommand(params, true);
    expect(supervision.admit).toHaveBeenCalledTimes(1);
    expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toContain("Supervised task cancelled");
    expect(result?.reply?.text).toContain("Agent was aborted");
  },
);

// The command boundary must still stop the exact ordinary target if supervision
// fails either before the control write or in the durable store itself.
it.each([
  { command: "/stop", failure: "database" },
  { command: "/stop", failure: "source" },
  { command: "stop", failure: "database" },
  { command: "stop", failure: "source" },
])(
  "preserves ordinary $command and reports supervised $failure failure",
  async ({ command, failure }) => {
    vi.clearAllMocks();
    supervision.admit.mockReset().mockRejectedValue(new Error("Supervision store unavailable"));
    formatAbortReplyTextMock.mockReturnValue("⚙️ Agent was aborted.");
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: true, aborted: true });
    const params = buildStopParams();
    params.command.rawBodyNormalized = command;
    params.command.commandBodyNormalized = command;
    params.agentId = "target";
    params.provider = "openai";
    params.model = "fixture";
    params.cfg.agents = {
      entries: {
        target: { taskSupervision: { enabled: true, policyFile: "/unused-policy.json" } },
      },
    };
    setChannelSourceTurnId(params.ctx, "failed-stop-input");
    const target = { sessionId: "durable-session", updatedAt: 1000 };
    resolveCommandSessionEntryForKeyMock.mockReturnValue({
      entry: target,
      key: "agent:target:telegram:direct:123",
    });
    supervision.session.mockReturnValue({
      entry: failure === "source" ? { ...target, sessionId: "replacement-session" } : target,
    });
    const handler = command === "/stop" ? handleStopCommand : handleAbortTrigger;
    const result = await handler(params, true);
    expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledExactlyOnceWith({
      key: "agent:target:telegram:direct:123",
      sessionId: "durable-session",
    });
    expect(persistAbortTargetEntryMock).toHaveBeenCalledTimes(1);
    if (command === "/stop") {
      expect(stopSubagentsForRequesterMock).toHaveBeenCalledTimes(1);
      expect(createInternalHookEventMock).toHaveBeenCalledTimes(1);
    }
    expect(result?.reply?.text).toContain("Agent was aborted");
    expect(result?.reply?.text).toContain("Supervised task cancellation could not be confirmed");
    expect(result?.reply?.text).toContain("Retry /stop");
  },
);
