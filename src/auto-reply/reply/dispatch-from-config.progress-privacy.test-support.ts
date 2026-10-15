import { expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createDispatcher, sessionStoreMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

// Registered inside the existing dispatch suite so privacy and routing share its mock graph.
export function registerProgressPrivacyTests() {
  it.each([
    { name: "automatic", mode: "automatic" as const, sendPolicy: "allow" as const, visible: true },
    {
      name: "message tool only",
      mode: "message_tool_only" as const,
      sendPolicy: "allow" as const,
      visible: false,
    },
    { name: "denied", mode: "automatic" as const, sendPolicy: "deny" as const, visible: false },
  ])(
    "gates an admitted preview receipt for $name delivery",
    async ({ mode, sendPolicy, visible }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy };
      const onPreviewStart = vi.fn(() => false);
      const onPartialReply = vi.fn(() => false);
      const onPreparedAgentRunStart = vi.fn(() => "reply-dispatch");
      const dispatcher = createDispatcher();
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          From: "telegram:123",
          SessionKey: "agent:main:telegram:dm:123",
        }),
        cfg: { ...automaticGroupReplyConfig, session: { sendPolicy: { default: sendPolicy } } },
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: mode,
          onPreviewStart,
          onPartialReply,
          onPreparedAgentRunStart,
        },
        replyResolver: async (_ctx, options) => {
          expect(onPreviewStart).not.toHaveBeenCalled();
          expect(
            options?.onPreparedAgentRunStart?.({ runId: "receipt-run", transcriptStart: null }),
          ).toBe("reply-dispatch");
          await options?.onPreviewStart?.();
          await options?.onPartialReply?.({ text: "Candidate preview" });
          return { text: "Completed" } satisfies ReplyPayload;
        },
      });
      expect(result.sendPolicyDenied ?? false).toBe(sendPolicy === "deny");
      expect(onPreparedAgentRunStart).toHaveBeenCalledOnce();
      expect(onPreviewStart).toHaveBeenCalledTimes(visible ? 2 : 0);
      expect(onPartialReply).toHaveBeenCalledTimes(visible ? 1 : 0);
    },
  );

  it.each([
    { surface: "telegram", mentioned: false },
    { surface: "telegram", mentioned: true },
    { surface: "discord", mentioned: false },
    { surface: "discord", mentioned: true },
  ])(
    "keeps optional $surface draft progress private (mentioned: $mentioned)",
    async ({ surface, mentioned }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { verboseLevel: "off" };
      const dispatcher = createDispatcher();
      const onItemEvent = vi.fn();
      const onToolStart = vi.fn();
      const onPlanUpdate = vi.fn();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: surface,
          Surface: surface,
          ChatType: "group",
          From: `${surface}:group:fixture`,
          SessionKey: `agent:main:${surface}:group:fixture`,
          WasMentioned: mentioned,
        }),
        cfg: {
          ...automaticGroupReplyConfig,
          agents: { defaults: { silentReply: { group: "allow" } } },
        },
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          progressRequiresReply: true,
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onItemEvent,
          onToolStart,
          onPlanUpdate,
        },
        replyResolver: async (_ctx, opts) => {
          await opts?.onItemEvent?.({
            itemId: "preamble",
            kind: "preamble",
            phase: "end",
            progressText: "Inspecting the request",
          });
          await opts?.onToolStart?.({ name: "exec", phase: "start" });
          await opts?.onPlanUpdate?.({
            phase: "update",
            steps: [{ step: "Inspect", status: "in_progress" }],
          });
          return undefined;
        },
      });
      expect(onItemEvent).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      expect(onToolStart).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      expect(onPlanUpdate).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("forwards channel-owned group progress callbacks while source delivery is suppressed", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "off" };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onToolResult = vi.fn();

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onToolResult,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });
}
