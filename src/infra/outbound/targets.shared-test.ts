import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import { resolveOutboundTarget } from "./targets.js";

type TelegramTargetParts = {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
};

function parseTelegramTestTarget(raw: string): TelegramTargetParts {
  const trimmed = raw
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
  const topicMatch = /^(.+?):topic:(\d+)$/u.exec(trimmed);
  if (topicMatch) {
    const chatId = topicMatch[1];
    return {
      chatId,
      messageThreadId: Number.parseInt(topicMatch[2], 10),
      chatType: chatId.startsWith("-") ? "group" : "direct",
    };
  }

  const threadMatch = /^(.+):(\d+)$/u.exec(trimmed);
  if (threadMatch) {
    const chatId = threadMatch[1];
    return {
      chatId,
      messageThreadId: Number.parseInt(threadMatch[2], 10),
      chatType: chatId.startsWith("-") ? "group" : "direct",
    };
  }

  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : "direct",
  };
}

const telegramMessaging = {
  parseExplicitTarget: ({ raw }: { raw: string }) => parseTelegramTestMessagingTarget(raw),
};

export function inferTelegramTestChatType(to: string): "direct" | "group" | undefined {
  const chatType = parseTelegramTestTarget(to).chatType;
  return chatType === "unknown" ? undefined : chatType;
}

export function parseTelegramTestMessagingTarget(raw: string): {
  to: string;
  threadId?: number;
  chatType?: "direct" | "group";
} {
  const target = parseTelegramTestTarget(raw);
  return {
    to: target.chatId,
    threadId: target.messageThreadId,
    chatType: target.chatType === "unknown" ? undefined : target.chatType,
  };
}

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

export const telegramOutboundStub: ChannelOutboundAdapter = {
  deliveryMode: "direct",
};

export const whatsappOutboundStub: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  resolveTarget: ({ to }) => {
    const normalized = typeof to === "string" ? normalizeWhatsAppTarget(to) : undefined;
    if (normalized) {
      return { ok: true as const, to: normalized };
    }
    return {
      ok: false as const,
      error: new Error("WhatsApp target required"),
    };
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
              outbound: whatsappOutboundStub,
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
              outbound: telegramOutboundStub,
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
