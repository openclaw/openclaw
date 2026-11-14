import { describe, expect, it, vi } from "vitest";
import { createChannelMessageAdapterFromOutbound } from "../../channels/message/outbound-bridge.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { installRouteReplyFixture } from "./route-reply.fixture.test-support.js";
import { routeReply } from "./route-reply.js";

// The 08:38 Peanutto incident: Telegram received the request, then the socket reset
// before its response arrived (`read ECONNRESET`).
function connectionResetAfterWrite() {
  return Object.assign(new Error("Network request for 'sendRichMessage' failed!"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
  });
}

describe("routed final replies after an ambiguous transport failure", () => {
  const fixtures = installRouteReplyFixture(true);

  function register(replayAmbiguousFinalText: boolean) {
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
        return { channel: "matrix", messageId: `sent-${attempts}` };
      },
    };
    const message = createChannelMessageAdapterFromOutbound({ id: "matrix", outbound });
    message.durableFinal = { ...message.durableFinal, replayAmbiguousFinalText };
    const plugin = { ...createOutboundTestPlugin({ id: "matrix", outbound }), message };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    return { visible, attempts: () => attempts };
  }

  const route = (replyKind: "final" | "tool") =>
    routeReply({
      payload: { text: "The review of 40782's new render failed after about 10 minutes." },
      channel: "matrix",
      to: "!room:example",
      sessionKey: "agent:main:matrix:group:room",
      cfg: {},
      replyKind,
      assertCurrent: () => undefined,
    });

  it("resends a routed exec-completion final once when the channel accepts duplicates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const channel = register(true);
      const result = await route("final");
      expect(result).toMatchObject({ ok: true, delivered: true });
      expect(channel.attempts()).toBe(2);
      expect(channel.visible).toEqual([
        "The review of 40782's new render failed after about 10 minutes.",
      ]);
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a channel without the opt-in", true, false],
    ["a non-final reply", false, true],
  ] as const)("does not blindly replay %s", async (_label, final, optIn) => {
    const channel = register(optIn);
    const result = await route(final ? "final" : "tool");
    expect(result).toMatchObject({ ok: false, delivered: false, ambiguous: true });
    expect(channel.attempts()).toBe(1);
  });
});
