import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createDispatcher, emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  setNoAbort,
  firstFinalReplyPayload,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { buildTestCtx } from "./test-ctx.js";

// Registered in the original suite so its shared fixtures and lifecycle remain authoritative.
export function registerAutomaticSourceDeliveryTests(): void {
  async function expectAutomaticDelivery(params: {
    ctx: Partial<MsgContext>;
    cfg: OpenClawConfig;
    text: string;
    replyOptions?: InternalGetReplyOptions;
    checkTyping?: boolean;
  }) {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      if (params.checkTyping) {
        expect(opts?.suppressTyping).toBe(false);
      }
      return { text: params.text } satisfies ReplyPayload;
    });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx(params.ctx),
      cfg: params.cfg,
      dispatcher,
      replyOptions: params.replyOptions,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe(params.text);
  }

  it("falls back to automatic group/channel delivery when the message tool is unavailable", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        tools: { allow: ["read"] },
      } as OpenClawConfig,
      text: "visible fallback",
    });
  });

  it("falls back to automatic group/channel delivery when group tools remove the message tool", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        From: "discord:channel:C1",
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:discord:channel:C1",
      },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        channels: {
          discord: {
            groups: {
              C1: { tools: { allow: ["read"] } },
            },
          },
        },
      } as OpenClawConfig,
      text: "group policy fallback",
    });
  });

  it("falls back when a channel precomputed message-tool-only delivery but the message tool is unavailable", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: { tools: { allow: ["read"] } } as OpenClawConfig,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
      text: "requested fallback",
    });
  });

  it("keeps native command replies visible in group/channel events", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "group",
        CommandSource: "native",
        CommandAuthorized: true,
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      },
      cfg: emptyConfig,
      text: "status reply",
      checkTyping: true,
    });
  });

  it("keeps default group/channel source delivery automatic", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "group",
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      },
      cfg: emptyConfig,
      text: "final reply",
    });
  });
}
