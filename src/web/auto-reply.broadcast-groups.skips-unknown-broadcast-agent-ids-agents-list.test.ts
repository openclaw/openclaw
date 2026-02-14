import "./test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
    } satisfies OpenClawConfig);

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const seen: string[] = [];
    const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
      seen.push(String(ctx.SessionKey));
      return { text: "ok" };
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      id: "m1",
      from: "+1000",
      conversationId: "+1000",
      to: "+2000",
      body: "hello",
      timestamp: Date.now(),
      chatType: "direct",
      chatId: "direct:+1000",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
    resetLoadConfigMock();
  });
});
