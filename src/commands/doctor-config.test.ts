import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { checkDeprecatedConfigFields } from "./doctor-config.js";

/**
 * Helper: build a minimal OpenClawConfig with only the fields we care about.
 * The `as unknown as OpenClawConfig` cast lets us mix in deprecated fields
 * that are no longer part of the official schema.
 */
function makeConfig(extra: Record<string, unknown> = {}): OpenClawConfig {
  return {
    ...extra,
  } as unknown as OpenClawConfig;
}

describe("checkDeprecatedConfigFields", () => {
  it("returns no warnings for a clean config", () => {
    const warnings = checkDeprecatedConfigFields(makeConfig());
    expect(warnings).toHaveLength(0);
  });

  describe("messages.audioModels", () => {
    it("warns when audioModels is set", () => {
      const cfg = makeConfig({ messages: { audioModels: ["whisper"] } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("messages.audioModels");
      expect(warnings[0]).toContain("tools.media.audio.models");
    });

    it("does not warn when messages.audioModels is absent", () => {
      const cfg = makeConfig({ messages: { inbound: {} } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("audioModels"))).toBe(false);
    });
  });

  describe("messages.messagePrefix", () => {
    it("warns when messagePrefix is set", () => {
      const cfg = makeConfig({ messages: { messagePrefix: "Bot: " } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("messages.messagePrefix");
      expect(warnings[0]).toContain("whatsapp.messagePrefix");
    });

    it("does not warn when messagePrefix is absent", () => {
      const cfg = makeConfig({ messages: {} });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("messagePrefix"))).toBe(false);
    });
  });

  describe("dmMode (top-level, deprecated)", () => {
    it("warns when dmMode is set", () => {
      const cfg = makeConfig({ dmMode: "direct" });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("dmMode");
    });

    it("does not warn when dmMode is absent", () => {
      const warnings = checkDeprecatedConfigFields(makeConfig());
      expect(warnings.some((w) => w.includes("dmMode"))).toBe(false);
    });
  });

  describe("sessions.maintenance.days (pruneDays)", () => {
    it("warns when maintenance has a days field", () => {
      const cfg = makeConfig({ session: { maintenance: { days: 30 } } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("pruneDays");
      expect(warnings[0]).toContain("pruneAfter");
    });

    it("does not warn when maintenance uses pruneAfter instead", () => {
      const cfg = makeConfig({ session: { maintenance: { pruneAfter: "30d" } } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("pruneDays"))).toBe(false);
    });

    it("does not warn when session.maintenance is absent", () => {
      const cfg = makeConfig({ session: {} });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("pruneDays"))).toBe(false);
    });
  });

  describe("tools.media.audio.deepgram", () => {
    it("warns when nested deepgram config is present", () => {
      const cfg = makeConfig({ tools: { media: { audio: { deepgram: { apiKey: "sk-x" } } } } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("tools.media.audio.deepgram"))).toBe(true);
      expect(warnings.some((w) => w.includes("providerOptions.deepgram"))).toBe(true);
    });
  });

  describe("tools.media.deepgram (old top-level position)", () => {
    it("warns when deepgram is at media level", () => {
      const cfg = makeConfig({ tools: { media: { deepgram: { apiKey: "sk-x" } } } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("tools.media.deepgram"))).toBe(true);
    });
  });

  describe("slack.dmReplyMode (legacy root-level)", () => {
    it("warns when root-level slack.dmReplyMode is set", () => {
      const cfg = makeConfig({ slack: { dmReplyMode: "all" } });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("slack.dmReplyMode");
      expect(warnings[0]).toContain("channels.slack.replyToModeByChatType.direct");
    });

    it("does not warn for current channels.slack config", () => {
      const cfg = makeConfig({
        channels: { slack: { replyToModeByChatType: { direct: "all" } } },
      });
      const warnings = checkDeprecatedConfigFields(cfg);
      expect(warnings.some((w) => w.includes("dmReplyMode"))).toBe(false);
    });
  });

  it("accumulates multiple warnings when several deprecated fields are present", () => {
    const cfg = makeConfig({
      messages: { audioModels: ["whisper"], messagePrefix: "Bot: " },
      dmMode: "direct",
    });
    const warnings = checkDeprecatedConfigFields(cfg);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
