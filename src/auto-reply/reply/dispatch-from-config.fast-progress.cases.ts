import { expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { dispatchReplyFromConfig, setNoAbort } from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerFastAutoProgressCases() {
  const sendPolicySessionEntry = (sendPolicy: "allow" | "deny") => ({
    sessionId: "s1",
    updatedAt: 0,
    sendPolicy,
  });
  it("suppresses fast auto progress when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = sendPolicySessionEntry("deny");
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return {} satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        forceToolResultProgress: true,
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sendPolicyDenied).toBe(true);
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses fast auto progress callbacks when verbose progress is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = sendPolicySessionEntry("allow");
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return {} satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards hidden fast auto progress only to lifecycle callbacks", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = sendPolicySessionEntry("allow");
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn(() => false);
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return {} satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        allowToolLifecycleWhenProgressHidden: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledOnce();
    expect(onToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each(["off", "on"] as const)(
    "falls back once when a forced fast auto callback declines visibility at verbose %s",
    async (verboseLevel) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = {
        sessionId: "s1",
        updatedAt: 0,
        sendPolicy: "allow",
        verboseLevel,
      };
      const dispatcher = createDispatcher();
      const onToolResult = vi.fn(() => false);
      const payload = {
        text: "💨Fast: auto-on",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      } satisfies ReplyPayload;
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.onToolResult?.(payload);
        return {} satisfies ReplyPayload;
      });

      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          forceToolResultProgress: true,
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onToolResult,
        },
      });

      expect(result.queuedFinal).toBe(false);
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(onToolResult).toHaveBeenCalledOnce();
      expect(onToolResult).toHaveBeenCalledWith(payload);
      expect(dispatcher.sendToolResult).toHaveBeenCalledOnce();
      expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("delivers forced fast auto progress once without a channel callback", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return {} satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        forceToolResultProgress: true,
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledOnce();
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
  });

  it("does not invoke a source-suppressed fast auto callback without opt-in", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn(() => true);
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return {} satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        forceToolResultProgress: true,
        suppressDefaultToolProgressMessages: true,
        onToolResult,
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).toHaveBeenCalledOnce();
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    { callbackResult: true, verboseLevel: "off" },
    { callbackResult: undefined, verboseLevel: "off" },
    { callbackResult: true, verboseLevel: "on" },
    { callbackResult: undefined, verboseLevel: "on" },
  ] as const)(
    "does not duplicate forced fast auto progress accepted with $callbackResult at verbose $verboseLevel",
    async ({ callbackResult, verboseLevel }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = {
        sessionId: "s1",
        updatedAt: 0,
        sendPolicy: "allow",
        verboseLevel,
      };
      const dispatcher = createDispatcher();
      const onToolResult = vi.fn(() => callbackResult);
      const payload = {
        text: "💨Fast: auto-on",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      } satisfies ReplyPayload;
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.onToolResult?.(payload);
        return {} satisfies ReplyPayload;
      });

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          forceToolResultProgress: true,
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onToolResult,
        },
      });

      expect(onToolResult).toHaveBeenCalledOnce();
      expect(onToolResult).toHaveBeenCalledWith(payload);
      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );
}
