import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramOutbound, whatsappOutbound } from "../../../test/channel-outbounds.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../plugin-sdk/whatsapp-targets.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOutboundTarget } from "./targets.js";

function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "");
  const prefixedTopic = /^group:([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    return {
      chatId: prefixedTopic[1],
      messageThreadId: Number.parseInt(prefixedTopic[2], 10),
      chatType: "group",
    };
  }
  const topic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topic) {
    return {
      chatId: topic[1],
      messageThreadId: Number.parseInt(topic[2], 10),
      chatType: topic[1].startsWith("-") ? "group" : "direct",
    };
  }
  const colonPair = /^([^:]+):(\d+)$/i.exec(trimmed);
  if (colonPair && colonPair[1].startsWith("-")) {
    return {
      chatId: colonPair[1],
      messageThreadId: Number.parseInt(colonPair[2], 10),
      chatType: "group",
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : "unknown",
  };
}

const telegramMessaging = {
  parseExplicitTarget: ({ raw }: { raw: string }) => {
    const target = parseTelegramTargetForTest(raw);
    return {
      to: target.chatId,
      threadId: target.messageThreadId,
      chatType: target.chatType === "unknown" ? undefined : target.chatType,
    };
  },
};

const whatsappMessaging = {
  inferTargetChatType: ({ to }: { to: string }) => {
    const normalized = normalizeWhatsAppTarget(to);
    if (!normalized) {
      return undefined;
    }
    return isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const);
  },
  targetResolver: {
    hint: "<E.164|group JID>",
  },
};

export function installResolveOutboundTargetPluginRegistryHooks(): void {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          plugin: {
            ...createOutboundTestPlugin({
              id: "whatsapp",
              label: "WhatsApp",
              outbound: whatsappOutbound,
              messaging: whatsappMessaging,
            }),
            config: {
              listAccountIds: () => [],
              resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) =>
                typeof cfg.channels?.whatsapp?.defaultTo === "string"
                  ? cfg.channels.whatsapp.defaultTo
                  : undefined,
            },
          },
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: {
            ...createOutboundTestPlugin({
              id: "telegram",
              label: "Telegram",
              outbound: telegramOutbound,
              messaging: telegramMessaging,
            }),
            config: {
              listAccountIds: () => [],
              resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) =>
                typeof cfg.channels?.telegram?.defaultTo === "string"
                  ? cfg.channels.telegram.defaultTo
                  : undefined,
            },
          },
          source: "test",
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
}

export function runResolveOutboundTargetCoreTests(): void {
  describe("resolveOutboundTarget", () => {
    installResolveOutboundTargetPluginRegistryHooks();

    it("rejects whatsapp with empty target even when allowFrom configured", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+1555"] } },
      };
      const res = resolveOutboundTarget({
        channel: "whatsapp",
        to: "",
        cfg,
        mode: "explicit",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WhatsApp");
      }
    });

    it.each([
      {
        name: "normalizes whatsapp target when provided",
        input: { channel: "whatsapp" as const, to: " (555) 123-4567 " },
        expected: { ok: true as const, to: "+5551234567" },
      },
      {
        name: "keeps whatsapp group targets",
        input: { channel: "whatsapp" as const, to: "120363401234567890@g.us" },
        expected: { ok: true as const, to: "120363401234567890@g.us" },
      },
      {
        name: "normalizes prefixed/uppercase whatsapp group targets",
        input: {
          channel: "whatsapp" as const,
          to: " WhatsApp:120363401234567890@G.US ",
        },
        expected: { ok: true as const, to: "120363401234567890@g.us" },
      },
      {
        name: "rejects whatsapp with empty target and allowFrom (no silent fallback)",
        input: { channel: "whatsapp" as const, to: "", allowFrom: ["+1555"] },
        expectedErrorIncludes: "WhatsApp",
      },
      {
        name: "rejects whatsapp with empty target and prefixed allowFrom (no silent fallback)",
        input: {
          channel: "whatsapp" as const,
          to: "",
          allowFrom: ["whatsapp:(555) 123-4567"],
        },
        expectedErrorIncludes: "WhatsApp",
      },
      {
        name: "rejects invalid whatsapp target",
        input: { channel: "whatsapp" as const, to: "wat" },
        expectedErrorIncludes: "WhatsApp",
      },
      {
        name: "rejects whatsapp without to when allowFrom missing",
        input: { channel: "whatsapp" as const, to: " " },
        expectedErrorIncludes: "WhatsApp",
      },
      {
        name: "rejects whatsapp allowFrom fallback when invalid",
        input: { channel: "whatsapp" as const, to: "", allowFrom: ["wat"] },
        expectedErrorIncludes: "WhatsApp",
      },
    ])("$name", ({ input, expected, expectedErrorIncludes }) => {
      const res = resolveOutboundTarget(input);
      if (expected) {
        expect(res).toEqual(expected);
        return;
      }
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain(expectedErrorIncludes);
      }
    });

    it("rejects telegram with missing target", () => {
      const res = resolveOutboundTarget({ channel: "telegram", to: " " });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Telegram");
      }
    });

    it("rejects webchat delivery", () => {
      const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WebChat");
      }
    });
  });
}
