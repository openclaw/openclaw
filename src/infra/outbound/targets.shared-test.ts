import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOutboundTarget } from "./targets.js";

export function installResolveOutboundTargetPluginRegistryHooks(): void {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
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
