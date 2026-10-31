// Root-owned integration combines shared delivery with public plugin surfaces.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { googlechatPlugin } from "../extensions/googlechat/api.js";
import { ircPlugin } from "../extensions/irc/api.js";
import { telegramOutbound } from "../extensions/telegram/api.js";
import { whatsappPlugin } from "../extensions/whatsapp/api.js";
import { createDirectTextMediaOutbound } from "../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../src/channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { deliverOutboundPayloadsCore } from "../src/infra/outbound/deliver-core.js";
import { prepareOutboundPayloadBatch } from "../src/infra/outbound/deliver-prepare.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../src/test-utils/channel-plugins.js";

const literalCode = '`<p class="literal">code</p>`';
const angleText = "<https://example.com/a.pdf|Manual>";
const fixtures = [
  {
    text: `before<p title="a>b">inside</p>after\n\n${literalCode}`,
    plainText: `before\ninside\nafter\n\n${literalCode}`,
  },
  {
    text: `before<div title='a>b'>inside</div>after\n\n${literalCode}`,
    plainText: `before\ninside\nafter\n\n${literalCode}`,
  },
  {
    text: 'before<a href="`hidden`">click</a> then `visible`',
    plainText: "beforeclick then `visible`",
  },
  { text: angleText, plainText: "Manual" },
];
const payloads = fixtures.map(({ text }) => ({ text }));

async function deliver(params: Parameters<typeof prepareOutboundPayloadBatch>[0]) {
  const preparedBatch = await prepareOutboundPayloadBatch(params);
  return deliverOutboundPayloadsCore({ ...params, preparedBatch });
}

type Sanitizer = Pick<ChannelOutboundAdapter, "sanitizeText" | "normalizePayload">;
const sharedPlainTextSiblings: Array<[string, Sanitizer]> = [
  ["googlechat", expectDefined(googlechatPlugin.outbound, "googlechatPlugin.outbound")],
  ["irc", expectDefined(ircPlugin.outbound, "ircPlugin.outbound")],
  ["whatsapp", expectDefined(whatsappPlugin.outbound, "whatsappPlugin.outbound")],
];

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

function register(channel: string, outbound: ChannelOutboundAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channel,
        source: "test",
        plugin: createOutboundTestPlugin({ id: channel, outbound }),
      },
    ]),
  );
}

function createTextDelivery(mode: "default Telegram" | "rich Telegram" | "direct text/media") {
  const send = vi.fn(async (_to: string, _text: string) => ({
    messageId: "fixture-message",
    chatId: "12345",
  }));
  const channel = mode === "direct text/media" ? "imessage" : "telegram";
  const cfg: OpenClawConfig =
    mode === "rich Telegram" ? { channels: { telegram: { richMessages: true } } } : {};
  const outbound =
    channel === "telegram"
      ? telegramOutbound
      : createDirectTextMediaOutbound({
          channel,
          resolveSender: () => send,
          resolveMaxBytes: () => undefined,
          buildTextOptions: () => ({}),
          buildMediaOptions: () => ({}),
        });
  register(channel, outbound);
  return { send, params: { cfg, channel, to: "12345", deps: { telegram: send } } };
}

it.each(["default Telegram", "rich Telegram", "direct text/media"] as const)(
  "preserves the %s transport contract",
  async (mode) => {
    const { send, params: base } = createTextDelivery(mode);
    expect(await deliver({ ...base, payloads })).toHaveLength(payloads.length);
    expect(send.mock.calls.map(([to, text]) => [to, text])).toEqual(
      fixtures.map(({ text, plainText }) => ["12345", mode === "rich Telegram" ? text : plainText]),
    );
  },
);

it.each(sharedPlainTextSiblings)(
  "keeps the unspaced angle-link label on the %s outbound delivery boundary",
  async (channel, source) => {
    const send = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => ({
      channel,
      messageId: "fixture-message",
    }));
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sanitizeText: source.sanitizeText,
      normalizePayload: source.normalizePayload,
      sendText: send,
    };
    register(channel, outbound);
    expect(
      await deliver({
        cfg: {} satisfies OpenClawConfig,
        channel,
        to: "12345",
        payloads: [{ text: angleText }],
      }),
    ).toHaveLength(1);
    expect(send.mock.calls.map(([call]) => [call.to, call.text])).toEqual([["12345", "Manual"]]);
  },
);
