import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import {
  resolveMessageActionOutcome,
  type MessageActionResult,
  type ResolvedActionContext,
} from "./message-action-contracts.js";
import { annotateSourceDelivery } from "./message-action-execution.js";
import { runMessageAction } from "./message-action-runner.js";
import type { MessageSendResult } from "./message.js";

const channel = "accepted-results";
const toolContext = {
  currentChannelProvider: channel,
  currentChannelId: "room-1",
  currentThreadTs: "thread-1",
};
const authorization = { requesterAccountId: "default", toolContext };
const sessionKey = `agent:main:${channel}:direct:room-1`;
const acceptedPayload = { ok: true, messageId: "accepted-1" };
const closed = new Error("delivery caller closed");

function registerPlugin(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: channel }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("expected native action dispatch");
      },
    },
    ...overrides,
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: channel, plugin, source: "test", origin: "bundled" }]),
  );
  return plugin;
}

describe("accepted results through registered message actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-accepted-results-");
  });
  afterEach(() => resetPluginRuntimeStateForTest());
  afterAll(async () => tempHome.restore());

  it.each(["sent", "partial_failed"] as const)(
    "keeps the matched core %s result accurate while its caller stays current",
    async (deliveryStatus) => {
      const plugin = registerPlugin();
      const sendResult: MessageSendResult = {
        channel,
        to: "room-1",
        via: "direct",
        mediaUrl: null,
        deliveryStatus,
        ...(deliveryStatus === "partial_failed"
          ? { error: "second part failed", sentBeforeError: true as const }
          : {}),
        result: { channel, messageId: "part-1" },
      };
      const result: MessageActionResult = {
        kind: "send",
        channel,
        action: "send",
        to: "room-1",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: false,
      };
      const ctx: ResolvedActionContext = {
        cfg: {},
        params: { to: "room-1" },
        channel,
        channelPlugin: plugin,
        accountId: "default",
        mediaAccess: { localRoots: [] },
        dryRun: false,
        input: {
          cfg: {},
          action: "send",
          params: {},
          sessionKey,
          messageActionAuthorization: {
            requesterAccountId: "default",
            toolContext: { currentChannelProvider: channel, currentChannelId: "room-1" },
          },
        },
      };
      const annotated = await annotateSourceDelivery(result, ctx, false);
      expect(annotated.sendResult).toBe(sendResult);
      if (deliveryStatus === "sent") {
        expect(annotated.payload).toHaveProperty("sourceReplyRoute", "current-source");
        expect(resolveMessageActionOutcome(annotated)).toEqual({ ok: true });
      } else {
        expect(annotated.payload).toHaveProperty("sourceReplyRoute", "current-source");
        expect(resolveMessageActionOutcome(annotated)).toEqual({
          ok: false,
          sentBeforeError: true,
          error: "second part failed",
        });
      }
    },
  );

  it.each([
    { mode: "plugin", messageId: "accepted-1" },
    { mode: "core", messageId: "accepted-1" },
    { mode: "core", messageId: "unknown" },
  ] as const)(
    "retains an accepted $mode send ($messageId) when its caller closes before annotation",
    async ({ mode, messageId }) => {
      let active = true;
      const submitted: string[] = [];
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertCurrent = () => {
        if (!active) {
          throw closed;
        }
      };
      const plugin = registerPlugin(
        mode === "plugin"
          ? {
              actions: {
                describeMessageTool: () => ({ actions: ["send"] }),
                handleAction: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push(messageId);
                  active = false;
                  return jsonResult(acceptedPayload);
                },
              },
            }
          : {
              outbound: {
                deliveryMode: "direct",
                sendText: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push(messageId);
                  active = false;
                  return {
                    channel,
                    messageId,
                    receipt: createMessageReceiptFromOutboundResults({
                      results: messageId === "unknown" ? [] : [{ channel, messageId }],
                      kind: "text",
                    }),
                  };
                },
              },
            },
      );

      const result = await runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: plugin.id, target: "room-1", message: "accepted reply" },
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch,
        skipQueue: true,
        suppressTranscriptMirror: true,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: mode, dryRun: false });
      expect(submitted).toEqual([messageId]);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
      if (result.kind !== "send") {
        throw new Error("Expected send result");
      }
      if (mode === "plugin") {
        expect(result.payload).toBe(acceptedPayload);
        expect(result.toolResult?.details).toBe(acceptedPayload);
      } else {
        expect(result.sendResult).toMatchObject({
          deliveryStatus: "sent",
          result: { messageId },
        });
      }
    },
  );

  it.each(["accepted", "uncertain failure"] as const)(
    "retains a source-authorized broadcast %s after caller closure",
    async (scenario) => {
      const accepted = scenario === "accepted";
      const payload = accepted
        ? acceptedPayload
        : {
            ok: false,
            deliveryStatus: "failed",
            error: "provider result unknown",
            sentBeforeError: true,
          };
      let active = true;
      const handleAction = vi.fn(async () => {
        active = false;
        return jsonResult(payload);
      });
      registerPlugin({
        actions: { describeMessageTool: () => ({ actions: ["send"] }), handleAction },
      });

      const result = await runMessageAction({
        cfg: {},
        action: "broadcast",
        params: { channel, targets: ["room-1", "room-2"], message: "broadcast reply" },
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        skipQueue: true,
        suppressTranscriptMirror: true,
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw closed;
          }
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              to: "room-1",
              ok: accepted,
              payload,
              ...(accepted ? {} : { error: "provider result unknown", sentBeforeError: true }),
            },
            { to: "room-2", ok: false, attempted: false },
          ],
        },
      });
      expect(result).not.toHaveProperty("payload.results.0.attempted");
      expect(result).not.toHaveProperty("payload.results.0.payload.sourceReplyRoute");
      expect(resolveMessageActionOutcome(result).ok).toBe(false);
    },
  );

  it.each(["send", "poll", "set-presence"] as const)(
    "returns known partial %s facts to the caller with their failure outcome",
    async (action) => {
      const payload = {
        ok: false,
        deliveryStatus: "partial_failed",
        sentBeforeError: true,
        error: "second part failed",
        ...(action === "send"
          ? { messageId: "part-1" }
          : { result: { messageIds: ["part-1"], visibleReplySent: true } }),
      };
      let active = true;
      const handleAction = vi.fn(async () => {
        active = false;
        return jsonResult(payload);
      });
      registerPlugin({
        actions: {
          describeMessageTool: () => ({ actions: [action] }),
          handleAction,
        },
      });

      const result = await runMessageAction({
        cfg: {},
        action,
        params: {
          channel,
          ...(action === "set-presence" ? {} : { target: "room-1" }),
          message: "partial reply",
        },
        conversationReadOrigin: "direct-operator",
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        suppressTranscriptMirror: true,
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw closed;
          }
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(result.payload).toBe(payload);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
      expect(resolveMessageActionOutcome(result)).toEqual({
        ok: false,
        sentBeforeError: true,
        error: "second part failed",
      });
    },
  );

  it.each([
    "before lookup",
    "during lookup",
    "lookup failure",
    "current",
    "aborted before lookup",
    "aborted during lookup",
  ] as const)("preserves an accepted thread reply (%s)", async (scenario) => {
    let active = true;
    const caller = new AbortController();
    const matchesCurrentConversationAsync = vi.fn(async () => {
      if (scenario === "lookup failure") {
        throw new Error("source lookup unavailable");
      }
      if (scenario === "during lookup") {
        active = false;
      }
      if (scenario === "aborted during lookup") {
        caller.abort(closed);
      }
      return true;
    });
    const handleAction = vi.fn(async () => {
      if (scenario === "before lookup") {
        active = false;
      }
      if (scenario === "aborted before lookup") {
        caller.abort(closed);
      }
      return jsonResult(acceptedPayload);
    });
    registerPlugin({
      actions: {
        describeMessageTool: () => ({ actions: ["thread-reply"] }),
        messageActionTargetAliases: {
          "thread-reply": { aliases: ["threadId"], matchesCurrentConversationAsync },
        },
        handleAction,
      },
    });

    const result = await runMessageAction({
      cfg: {},
      action: "thread-reply",
      params: { channel, target: "room-1", threadId: "thread-1", message: "accepted reply" },
      conversationReadOrigin: "direct-operator",
      messageActionAuthorization: authorization,
      sessionKey,
      defaultAccountId: "default",
      abortSignal: caller.signal,
      assertDirectAdapterHandoff: scenario.startsWith("aborted")
        ? undefined
        : () => {
            if (!active) {
              throw closed;
            }
          },
    });

    expect(handleAction).toHaveBeenCalledOnce();
    expect(matchesCurrentConversationAsync).toHaveBeenCalledTimes(
      scenario === "before lookup" || scenario === "aborted before lookup" ? 0 : 1,
    );
    if (scenario === "current") {
      expect(result.payload).toMatchObject({
        ...acceptedPayload,
        sourceReplyRoute: "current-source",
      });
    } else {
      expect(result.payload).toBe(acceptedPayload);
      expect(result).toHaveProperty("toolResult.details", acceptedPayload);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
    }
  });

  it.each([
    { name: "unidentified", payload: {} },
    { name: "unconfirmed ID", payload: { messageId: "unconfirmed-1" } },
    { name: "unknown ID", payload: { ok: true, messageId: "unknown" } },
    { name: "rejected with an ID", payload: { ok: false, messageId: "rejected-1" } },
    {
      name: "nested rejection",
      payload: { ok: true, result: { ok: false, messageId: "rejected-1" } },
    },
    {
      name: "failure at the supported payload depth",
      payload: {
        ...acceptedPayload,
        result: { result: { result: { result: { ok: false } } } },
      },
    },
    {
      name: "nested error",
      payload: { ok: true, result: { error: "rejected", messageId: "rejected-1" } },
    },
    {
      name: "error status",
      payload: { ok: true, result: { status: "error", messageId: "rejected-1" } },
    },
    {
      name: "incomplete status",
      payload: { ok: true, result: { status: "incomplete", messageId: "part-1" } },
    },
    {
      name: "conflicting partial status",
      payload: { ok: true, deliveryStatus: "partial_failed", messageId: "part-1" },
    },
    {
      name: "conflicting partial and dry-run status",
      payload: {
        ok: false,
        deliveryStatus: "partial_failed",
        status: "dry_run",
        sentBeforeError: true,
      },
    },
    { name: "tool error", payload: acceptedPayload, toolError: true },
    {
      name: "conflicting error status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "error" },
    },
    {
      name: "conflicting incomplete status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "incomplete" },
    },
    {
      name: "conflicting failed status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "failed" },
    },
    { name: "tool failure status", payload: acceptedPayload, toolStatus: "failed" },
    { name: "tool partial status", payload: acceptedPayload, toolStatus: "partial_failed" },
    { name: "tool partial delivery", payload: acceptedPayload, toolPartial: true },
    {
      name: "partial delivery at the supported tool-result depth",
      payload: acceptedPayload,
      toolDetails: { result: { result: { result: { sentBeforeError: true } } } },
    },
    { name: "tool dry run", payload: acceptedPayload, toolDryRun: true },
    { name: "dry run", payload: acceptedPayload, dryRun: true },
    { name: "read", payload: acceptedPayload, action: "read" as const },
    {
      name: "dry-run partial",
      payload: { ok: false, sentBeforeError: true, messageId: "part-1" },
      dryRun: true,
    },
    {
      name: "read partial",
      payload: { ok: false, sentBeforeError: true, messageId: "part-1" },
      action: "read" as const,
    },
  ])("keeps $name strict when annotation loses authority", async (testCase) => {
    const plugin = registerPlugin();
    const result: MessageActionResult = {
      ...(testCase.action === "read"
        ? { kind: "action", action: "read" }
        : { kind: "send", action: "send", to: "room-1" }),
      channel,
      handledBy: "plugin",
      payload: testCase.payload,
      toolResult: {
        ...jsonResult(testCase.toolDetails ?? testCase.payload),
        ...(testCase.toolError ? { isError: true } : {}),
        ...(testCase.toolStatus ? { status: testCase.toolStatus } : {}),
        ...(testCase.toolPartial ? { sentBeforeError: true } : {}),
        ...(testCase.toolDryRun ? { dryRun: true } : {}),
      },
      dryRun: testCase.dryRun ?? false,
    };
    const ctx: ResolvedActionContext = {
      cfg: {},
      params: { to: "room-1" },
      channel,
      channelPlugin: plugin,
      mediaAccess: { localRoots: [] },
      dryRun: result.dryRun,
      input: {
        cfg: {},
        action: result.action,
        params: {},
        messageActionAuthorization: authorization,
        assertDirectAdapterHandoff: () => {
          throw closed;
        },
      },
    };

    await expect(annotateSourceDelivery(result, ctx, false)).rejects.toBe(closed);
    expect(result.payload).toBe(testCase.payload);
    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});
