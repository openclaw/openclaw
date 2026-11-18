import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { ReplyPayload } from "../types.js";
import {
  filterMessagingToolMediaDuplicates,
  resolveMessagingToolPayloadDedupe,
} from "./reply-payloads-dedupe.js";

const dedupeRoute = (params: Parameters<typeof resolveMessagingToolPayloadDedupe>[0] = {}) =>
  resolveMessagingToolPayloadDedupe({
    messageProvider: "telegram",
    originatingTo: "123",
    ...params,
  });
const sentTarget = (overrides: Partial<MessagingToolSend> = {}): MessagingToolSend => ({
  tool: "message",
  provider: "telegram",
  to: "123",
  ...overrides,
});
const matchesRoute = (
  target: Partial<MessagingToolSend>,
  params: Parameters<typeof resolveMessagingToolPayloadDedupe>[0] = {},
) =>
  dedupeRoute({
    messagingToolSentTargets: [sentTarget(target)],
    ...params,
  }).matchingRoute;
const filterMedia = (payloads: ReplyPayload[], sentMediaUrls: string[]) =>
  filterMessagingToolMediaDuplicates({ payloads, sentMediaUrls });
const emptyEvidence = {
  shouldDedupePayloads: true,
  matchingRoute: false,
  routeSentTexts: [],
  routeSentMediaUrls: [],
  useGlobalSentTextEvidenceFallback: false,
  useGlobalSentMediaUrlEvidenceFallback: false,
};

// Telegram is reachable only through bundled discovery, never the active registry,
// so these cases cover dedupe before the channel registers (#93107).
const bundled = vi.hoisted(() => ({ telegram: undefined as unknown }));
// mock-isolation: Bundled discovery serves only the real Telegram plugin.
vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (channel: string) =>
    channel === "telegram" ? bundled.telegram : undefined,
}));
bundled.telegram = (
  await loadBundledPluginFacade<{ telegramPlugin: unknown }>({
    pluginId: "telegram",
    artifactBasename: "api.ts",
  })
).telegramPlugin;

describe("filterMessagingToolMediaDuplicates", () => {
  const [photo, other, a, b, c, voice] = [
    "file:///tmp/photo.jpg",
    "file:///tmp/other.jpg",
    "file:///tmp/a.jpg",
    "file:///tmp/b.jpg",
    "file:///tmp/c.jpg",
    "file:///tmp/voice.ogg",
  ] as const;
  const delivery = { pin: { enabled: true, required: true } };
  it.each<[string, ReplyPayload, string[], ReplyPayload]>([
    [
      "preserves unmatched media",
      { text: "hello", mediaUrl: photo },
      [other],
      { text: "hello", mediaUrl: photo },
    ],
    [
      "filters media arrays",
      { text: "gallery", mediaUrls: [a, b, c] },
      [b],
      { text: "gallery", mediaUrls: [a, c] },
    ],
    [
      "dedupes both lowercase media fields while preserving unsent media",
      {
        mediaUrl: "https://example.test/one.png",
        mediaUrls: ["https://example.test/two.png", "https://example.test/three.png"],
      },
      ["https://example.test/one.png", "https://example.test/two.png"],
      { mediaUrl: undefined, mediaUrls: ["https://example.test/three.png"] },
    ],
    [
      "preserves delivery operations",
      { mediaUrl: photo, delivery },
      [photo],
      { mediaUrl: photo, delivery },
    ],
    [
      "clears voice metadata with its media",
      { mediaUrl: voice, audioAsVoice: true },
      [voice],
      { mediaUrl: undefined, mediaUrls: undefined, audioAsVoice: undefined },
    ],
  ])("%s", (_name, payload, sent, expected) => {
    expect(filterMedia([payload], sent)).toEqual([expected]);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }];
    expect(filterMedia(payloads, [])).toBe(payloads);
  });

  it.runIf(process.platform === "win32")(
    "dedupes Windows network file URLs across scheme casing",
    () => {
      const result = filterMedia(
        [{ text: "hello", mediaUrl: "FILE://server/share.png" }],
        ["file://server/share.png"],
      );
      expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
    },
  );
});

describe("resolveMessagingToolPayloadDedupe route matching", () => {
  beforeEach(() => resetPluginRuntimeStateForTest());
  it.each(["", "message"])("matches current route with provider placeholder %j", (provider) => {
    expect(matchesRoute({ provider })).toBe(true);
  });

  it("does not match when route accounts differ", () => {
    expect(matchesRoute({ accountId: "personal" }, { accountId: "work" })).toBe(false);
  });

  it.each([
    ["telegram:group:-100123:topic:77", { to: "-100123", threadId: "77" }, true],
    ["telegram:group:-100123:topic:77", { to: "-100123", threadId: "88" }, false],
    ["telegram:group:-100123:topic:77", { to: "-100123" }, false],
    ["telegram:group:-100123", { to: "-100123" }, true],
  ] as const)(
    "matches unregistered Telegram origin %s against %j: %s",
    (origin, target, expected) => {
      expect(matchesRoute(target, { originatingTo: origin })).toBe(expected);
    },
  );

  it("dedupes by content when messaging tool target metadata is unavailable", () => {
    expect(dedupeRoute()).toEqual(emptyEvidence);
  });

  it("dedupes final replies by content when a messaging tool sent to the same route", () => {
    const sent = sentTarget({ text: "sent text", mediaUrls: ["file:///tmp/sent.png"] });
    expect(dedupeRoute({ messagingToolSentTargets: [sent] })).toEqual({
      ...emptyEvidence,
      matchingRoute: true,
      routeSentTexts: ["sent text"],
      routeSentMediaUrls: ["file:///tmp/sent.png"],
    });
  });

  it("scopes matching-route evidence to the matched target", () => {
    expect(
      dedupeRoute({
        messageProvider: "slack",
        originatingTo: "channel:C1",
        messagingToolSentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord text",
            mediaUrls: ["file:///tmp/discord.png"],
          },
        ],
      }),
    ).toEqual({
      ...emptyEvidence,
      matchingRoute: true,
      routeSentTexts: ["slack text"],
    });
  });
});
