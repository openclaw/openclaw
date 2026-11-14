// Prepared sends use the shipped Discord adapters with only network I/O substituted.
// Plugin-action fallbacks and the capture consumer are synthetic; source matching,
// transcript writes, accepted-turn publication and history reconciliation are real.
import path from "node:path";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../../channels/inbound-event/session-transcript-context.runtime.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { readRecentUserAssistantTurnsForSession } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildEmbeddedAttemptToolRunContext } from "../embedded-agent-runner/run/attempt-tool-run-context.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "../harness/context-engine-turn-attempt.js";
import {
  createCommitTurn,
  createTurnEngine,
  createTurnLease,
} from "../harness/context-engine-turn.test-support.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const sessionKey = "agent:main:discord:channel:12345";
const sessionId = "local-source-session";
const runId = "local-source-run";
const sourceTurnId = "local-source-turn";
const request = { sender: "User", messageId: "request-60", body: 'reply only "60"' };
const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
  pluginId: "discord",
  artifactBasename: "api.ts",
});
const createDiscordSender = () =>
  vi.fn(async (_target: string, _text: string, _options?: unknown) => ({
    messageId: "answer-60",
    channelId: "12345",
  }));

function historyContext(): FinalizedMsgContext {
  return {
    Body: 'reply only "61"',
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 10, historyKind: "recent" },
    InboundHistory: [request],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

async function withLocalSource(
  mode: SourceReplyDeliveryMode,
  run: (fixture: {
    tool: ReturnType<typeof createMessageTool>;
    scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
    handleAction: Mock<() => Promise<ReturnType<typeof jsonResult>>>;
    sendDiscord: ReturnType<typeof createDiscordSender>;
    capture: () => Promise<ReturnType<typeof createCommitTurn>>;
  }) => Promise<void>,
  options: { prepared?: boolean; finalByDefault?: boolean; preparedText?: string } = {},
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "local-source-reply-" },
    async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const sessionEntry = { sessionId, updatedAt: 1, chatType: "channel" as const };
      const config: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
        session: { store: storePath },
        channels: { discord: { enabled: true } },
      };
      setRuntimeConfigSnapshot(config);
      stubMessageSecrets();
      const handleAction = vi.fn(async () =>
        jsonResult({ ok: true, messageId: "answer-60", channelId: "12345" }),
      );
      const sendDiscord = createDiscordSender();
      const sendPayload = discordPlugin.outbound?.sendPayload;
      const sendText = discordPlugin.outbound?.sendText;
      const prepareSendPayload = discordPlugin.actions?.prepareSendPayload;
      if (!sendPayload || !sendText || !prepareSendPayload) {
        throw new Error("Missing shipped Discord preparation or outbound adapter");
      }
      registerMessageChannel({
        ...createChannelTestPluginBase({
          id: "discord",
          capabilities: { chatTypes: ["channel"] },
          config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
        }),
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          resolveExecutionMode: () => "local",
          handleAction,
          ...(options.prepared
            ? {
                prepareSendPayload:
                  options.preparedText === undefined
                    ? prepareSendPayload
                    : async (ctx) => ({
                        ...(await prepareSendPayload(ctx)),
                        text: options.preparedText,
                      }),
              }
            : {}),
        },
        messaging: {
          normalizeTarget: (target) => target.replace(/^channel:/, ""),
          targetResolver: {
            looksLikeId: (target) => /^(?:channel:)?[0-9]+$/.test(target),
            hint: "<channel id>",
          },
        },
        outbound: options.prepared
          ? {
              ...discordPlugin.outbound,
              deliveryMode: "direct",
              sendPayload: (ctx) => sendPayload({ ...ctx, deps: { sendDiscord } }),
              sendText: (ctx) => sendText({ ...ctx, deps: { sendDiscord } }),
            }
          : {
              deliveryMode: "direct",
              sendText: async () => {
                throw new Error("unexpected core send");
              },
            },
      } satisfies ChannelPlugin);
      await replaceSessionEntry(scope, sessionEntry);
      const input = await persistUserTurnTranscript({
        ...scope,
        sessionEntry,
        logicalTurnId: sourceTurnId,
        input: {
          text: request.body,
          timestamp: 1,
          transport: { channel: "discord", messageId: request.messageId },
        },
      });
      if (!input?.admission) {
        throw new Error("missing real user admission");
      }
      const commitTurn = createCommitTurn();
      const lease = createTurnLease(createTurnEngine(commitTurn));
      const warn = vi.fn();
      await drainPendingContextEngineTurnsBeforeRun({ admission: input.admission, lease, warn });
      const source = {
        currentChannelProvider: "discord",
        currentChannelId: "12345",
        currentMessagingTarget: "12345",
        currentChatType: "channel" as const,
        currentMessageId: request.messageId,
        currentSourceTurnId: sourceTurnId,
      };
      const capability = mintMessageActionTurnCapability({
        agentId: "main",
        sessionKey,
        runId,
        requesterAccountId: "default",
        toolContext: source,
      });
      try {
        await run({
          scope,
          handleAction,
          sendDiscord,
          tool: createMessageTool({
            config,
            ...buildEmbeddedAttemptToolRunContext({
              messageToolFinalByDefault: options.finalByDefault,
            }),
            ...source,
            agentId: "main",
            agentSessionKey: sessionKey,
            runSessionKey: sessionKey,
            sessionId,
            runId,
            agentAccountId: "default",
            messageActionTurnCapability: capability,
            sourceReplyDeliveryMode: mode,
          }),
          capture: async () => {
            const events = await loadTranscriptEvents(scope);
            const terminalId = readTranscriptEventId(events.at(-1));
            const terminal =
              terminalId &&
              (await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: terminalId }));
            if (!terminal) {
              throw new Error("missing persisted terminal anchor");
            }
            await finalizeAcceptedContextEngineTurn({
              config,
              lease,
              warn,
              facts: {
                boundary: { admission: input.admission, terminal },
                sessionIdUsed: sessionId,
                sessionKey,
                promptError: false,
                aborted: false,
                yieldAborted: false,
              },
            });
            expect(warn).not.toHaveBeenCalled();
            return commitTurn;
          },
        });
      } finally {
        revokeMessageActionTurnCapability(capability);
      }
    },
  );
}

it.each(["automatic", "message_tool_only"] as const)(
  "persists and captures a local final source answer once in %s mode",
  async (mode) => {
    await withLocalSource(mode, async ({ tool, scope, handleAction, capture }) => {
      for (let replay = 0; replay < 2; replay++) {
        const result = await tool.execute("send-60", {
          action: "send",
          message: "60",
          final: true,
        });
        expect(result.details).toMatchObject({
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            sourceReplyDelivered: true,
          },
        });
      }
      expect(handleAction).toHaveBeenCalledTimes(2);
      const messages = (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage);
      const answers = messages.filter((message) => message?.role === "assistant");
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        content: [{ type: "text", text: "60" }],
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId,
          toolCallId: "send-60",
        },
      });
      const commitTurn = await capture();
      expect(commitTurn).toHaveBeenCalledOnce();
      expect(commitTurn.mock.calls[0]?.[0].messages).toMatchObject([
        { role: "user", content: request.body },
        {
          role: "assistant",
          content: [{ type: "text", text: "60" }],
          openclawDeliveryMirror: { final: true },
        },
      ]);
      expect(
        await readRecentUserAssistantTurnsForSession({
          ...scope,
          includeMessageToolSourceReplies: true,
        }),
      ).toMatchObject([
        { role: "user", text: request.body, messageId: request.messageId },
        { role: "assistant", text: "60", isCompletedAnswer: true },
      ]);
      const ctx = historyContext();
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(ctx.InboundHistory).toEqual([]);
    });
  },
);

it.each([
  { final: undefined, finalByDefault: undefined, preparedText: undefined },
  { final: true, finalByDefault: undefined, preparedText: undefined },
  { final: true, finalByDefault: false, preparedText: "prepared 60" },
])(
  "records a shipped Discord core send ($final/$finalByDefault)",
  async ({ final, finalByDefault, preparedText }) => {
    await withLocalSource(
      "automatic",
      async ({ tool, scope, handleAction, sendDiscord, capture }) => {
        const deliveredText = preparedText ?? "60";
        const result = await tool.execute("send-60", {
          action: "send",
          message: "60",
          ...(final === undefined ? {} : { final }),
        });
        expect(result.details).toMatchObject({ via: "direct", deliveryStatus: "sent" });
        expect(sendDiscord).toHaveBeenCalledOnce();
        expect(sendDiscord.mock.calls[0]?.slice(0, 2)).toEqual(["channel:12345", deliveredText]);
        expect(handleAction).not.toHaveBeenCalled();
        const answers = (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({
          content: [{ type: "text", text: deliveredText }],
          openclawDeliveryMirror: { final: true, sourceTurnId, toolCallId: "send-60" },
        });
        const committed = await capture();
        expect(committed.mock.calls[0]?.[0].messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: deliveredText }],
          }),
        );
        const ctx = historyContext();
        await mergeSessionTranscriptContext({ ...scope, ctx });
        expect(ctx.InboundHistory).toEqual([]);
      },
      { prepared: true, finalByDefault, preparedText },
    );
  },
);

it.each([
  { final: false, finalByDefault: undefined },
  { final: undefined, finalByDefault: false },
])(
  "does not complete a prepared progress send ($final/$finalByDefault)",
  async ({ final, finalByDefault }) => {
    await withLocalSource(
      "automatic",
      async ({ tool, scope, sendDiscord }) => {
        const result = await tool.execute("progress", {
          action: "send",
          message: "60",
          ...(final === undefined ? {} : { final }),
        });
        expect(sendDiscord).toHaveBeenCalledOnce();
        expect(result.details).not.toMatchObject({
          messageDelivery: { sourceReplyDelivered: true },
        });
        const answers = (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({
          openclawDeliveryMirror: { final: false, sourceTurnId },
        });
        const ctx = historyContext();
        await mergeSessionTranscriptContext({ ...scope, ctx });
        expect(ctx.InboundHistory).toEqual([request]);
      },
      { prepared: true, finalByDefault },
    );
  },
);

it("does not persist a failed prepared send or complete its source", async () => {
  await withLocalSource(
    "automatic",
    async ({ tool, scope, sendDiscord }) => {
      sendDiscord.mockRejectedValue(new Error("transport unavailable"));
      await expect(tool.execute("failed", { action: "send", message: "60" })).rejects.toThrow(
        "transport unavailable",
      );
      expect(sendDiscord).toHaveBeenCalledOnce();
      expect(
        (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant"),
      ).toEqual([]);
      const ctx = historyContext();
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(ctx.InboundHistory).toEqual([request]);
    },
    { prepared: true },
  );
});

it.each([
  {
    name: "progress",
    args: { final: false },
    receipt: { ok: true, messageId: "progress", channelId: "12345" },
    stored: 1,
  },
  {
    name: "dry run",
    args: { dryRun: true },
    receipt: { ok: true, messageId: "unused" },
    stored: 0,
  },
  { name: "failed send", receipt: { ok: false, messageId: "attempt" }, stored: 0 },
  {
    name: "partial send",
    receipt: { ok: false, sentBeforeError: true, messageId: "part" },
    stored: 0,
  },
  { name: "suppressed send", receipt: { status: "suppressed" }, stored: 0 },
  {
    name: "different recipient",
    receipt: { ok: true, messageId: "elsewhere", channelId: "99999" },
    stored: 0,
  },
])("does not complete the stored source turn for $name", async ({ args, receipt, stored }) => {
  await withLocalSource("automatic", async ({ tool, scope, handleAction }) => {
    handleAction.mockResolvedValue(jsonResult(receipt));
    await tool.execute("not-final", { action: "send", message: "60", final: true, ...args });
    const answers = (await loadTranscriptEvents(scope))
      .map(readTranscriptEventMessage)
      .filter((message) => message?.role === "assistant");
    expect(answers).toHaveLength(stored);
    if (stored) {
      expect(answers[0]).toMatchObject({ openclawDeliveryMirror: { final: false } });
    }
    const ctx = historyContext();
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(ctx.InboundHistory).toEqual([request]);
  });
});
