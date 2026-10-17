import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
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
const matchesRoute = (
  target: NonNullable<
    Parameters<typeof resolveMessagingToolPayloadDedupe>[0]["messagingToolSentTargets"]
  >[number],
  params: Parameters<typeof resolveMessagingToolPayloadDedupe>[0] = {},
) => dedupeRoute({ messagingToolSentTargets: [target], ...params }).matchingRoute;
const filterMedia = (
  payloads: Parameters<typeof filterMessagingToolMediaDuplicates>[0]["payloads"],
  sentMediaUrls: string[],
) => filterMessagingToolMediaDuplicates({ payloads, sentMediaUrls });
const emptyEvidence = {
  shouldDedupePayloads: true,
  matchingRoute: false,
  routeSentTexts: [],
  routeSentMediaUrls: [],
  useGlobalSentTextEvidenceFallback: false,
  useGlobalSentMediaUrlEvidenceFallback: false,
};

function targetsMatchTelegramReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const baseTarget = (value: string) =>
    value
      .replace(/^telegram:(group|channel):/u, "")
      .replace(/^telegram:/u, "")
      .replace(/:topic:.*$/u, "");
  const originTopic = params.originTarget.match(/:topic:([^:]+)$/u)?.[1];
  return (
    baseTarget(params.originTarget) === baseTarget(params.targetKey) &&
    (originTopic === undefined || originTopic === params.targetThreadId)
  );
}

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (channel: string) =>
    channel === "telegram"
      ? {
          outbound: {
            targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
          },
        }
      : undefined,
}));

describe("filterMessagingToolMediaDuplicates", () => {
  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMedia(
      [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      ["file:///tmp/other.jpg"],
    );
    expect(result).toEqual([{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMedia(
      [
        {
          text: "gallery",
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
        },
      ],
      ["file:///tmp/b.jpg"],
    );
    expect(result).toEqual([
      { text: "gallery", mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"] },
    ]);
  });

  it("preserves media for payloads with delivery operations", () => {
    const delivery = { pin: { enabled: true, required: true } };
    const payload = { mediaUrl: "file:///tmp/photo.jpg", delivery };
    const result = filterMedia([payload], ["file:///tmp/photo.jpg"]);
    expect(result).toEqual([payload]);
  });

  it("clears audioAsVoice when dedupe removes all media", () => {
    const result = filterMedia(
      [{ mediaUrl: "file:///tmp/voice.ogg", audioAsVoice: true }],
      ["file:///tmp/voice.ogg"],
    );
    expect(result).toEqual([
      {
        mediaUrl: undefined,
        mediaUrls: undefined,
        audioAsVoice: undefined,
      },
    ]);
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
  const installTelegramSuppressionRegistry = () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram-plugin",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
            },
          }),
        },
      ]),
    );
  };

  it("matches when target provider is missing but target matches current provider route", () => {
    expect(matchesRoute({ tool: "message", provider: "", to: "123" })).toBe(true);
  });

  it('matches when target provider uses "message" placeholder and target matches', () => {
    expect(matchesRoute({ tool: "message", provider: "message", to: "123" })).toBe(true);
  });

  it("does not match when route accounts differ", () => {
    expect(
      matchesRoute(
        { tool: "message", provider: "telegram", to: "123", accountId: "personal" },
        { accountId: "work" },
      ),
    ).toBe(false);
  });

  it("preserves string thread ids before plugin reply-suppression matching", () => {
    installTelegramSuppressionRegistry();
    const largeThreadId = "9007199254740993";

    expect(
      matchesRoute(
        { tool: "message", provider: "telegram", to: "-100123", threadId: largeThreadId },
        { originatingTo: `telegram:group:-100123:topic:${largeThreadId}` },
      ),
    ).toBe(true);
  });

  it("does not match telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      matchesRoute(
        { tool: "message", provider: "telegram", to: "-100123", threadId: "88" },
        { originatingTo: "telegram:group:-100123:topic:77" },
      ),
    ).toBe(false);
  });

  it("does not match telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      matchesRoute(
        { tool: "message", provider: "telegram", to: "-100123" },
        { originatingTo: "telegram:group:-100123:topic:77" },
      ),
    ).toBe(false);
  });

  it("matches telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      matchesRoute(
        { tool: "message", provider: "telegram", to: "-100123" },
        { originatingTo: "telegram:group:-100123" },
      ),
    ).toBe(true);
  });
});

describe("resolveMessagingToolPayloadDedupe", () => {
  it("dedupes by content when messaging tool target metadata is unavailable", () => {
    expect(dedupeRoute()).toEqual(emptyEvidence);
  });

  it("dedupes final replies by content when a messaging tool sent to the same route", () => {
    expect(
      dedupeRoute({
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "123",
            text: "sent text",
            mediaUrls: ["file:///tmp/sent.png"],
          },
        ],
      }),
    ).toEqual({
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
