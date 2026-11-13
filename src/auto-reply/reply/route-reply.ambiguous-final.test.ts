import { describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { installRouteReplyFixture } from "./route-reply.fixture.test-support.js";
import { routeReply } from "./route-reply.js";

function connectionResetAfterWrite() {
  return Object.assign(new Error("Network request for 'sendRichMessage' failed!"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
  });
}

describe("routed Telegram final replies after an ambiguous transport failure", () => {
  const fixtures = installRouteReplyFixture(true);

  function register(channel: "telegram" | "matrix") {
    const visible: string[] = [];
    let attempts = 0;
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async ({ text, onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        if (attempts++ === 0) {
          throw connectionResetAfterWrite();
        }
        visible.push(text);
        return { channel, messageId: "sent-" + attempts };
      },
    };
    const plugin = createOutboundTestPlugin({ id: channel, outbound });
    setActivePluginRegistry(createTestRegistry([{ pluginId: channel, source: "test", plugin }]));
    return { visible, attempts: () => attempts };
  }

  const route = (channel: "telegram" | "matrix", replyKind: "final" | "tool") =>
    routeReply({
      payload: { text: "The requested review is complete." },
      channel,
      to: channel === "telegram" ? "12345" : "!room:example",
      sessionKey: "agent:main:" + channel + ":direct:12345",
      cfg: {},
      replyKind,
      assertCurrent: () => undefined,
    });

  it("resends a routed Telegram exec-completion final once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const channel = register("telegram");
      const result = await route("telegram", "final");
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, delivered: true });
      expect(channel.attempts()).toBe(2);
      expect(channel.visible).toEqual(["The requested review is complete."]);
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a non-Telegram final", "matrix", "final"],
    ["a Telegram non-final reply", "telegram", "tool"],
  ] as const)("does not blindly replay %s", async (_label, destination, kind) => {
    const channel = register(destination);
    const result = await route(destination, kind);
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      delivered: false,
      ambiguous: true,
    });
    expect(channel.attempts()).toBe(1);
  });
});
