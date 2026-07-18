// Tests for transcript config normalization.
import { describe, expect, it } from "vitest";
import { resolveTranscriptsConfig } from "./config.js";

describe("resolveTranscriptsConfig", () => {
  it("returns safe defaults for undefined input", () => {
    const result = resolveTranscriptsConfig(undefined);
    expect(result).toEqual({
      enabled: false,
      maxUtterances: 2000,
      autoStart: [],
    });
  });

  it("returns safe defaults for null", () => {
    const result = resolveTranscriptsConfig(null);
    expect(result.enabled).toBe(false);
    expect(result.maxUtterances).toBe(2000);
  });

  it("returns safe defaults for non-object input", () => {
    const result = resolveTranscriptsConfig("not-an-object");
    expect(result).toEqual({
      enabled: false,
      maxUtterances: 2000,
      autoStart: [],
    });
  });

  it("returns safe defaults for empty object", () => {
    const result = resolveTranscriptsConfig({});
    expect(result).toEqual({
      enabled: false,
      maxUtterances: 2000,
      autoStart: [],
    });
  });

  describe("enabled", () => {
    it("is false by default", () => {
      expect(resolveTranscriptsConfig({}).enabled).toBe(false);
    });

    it("is false when explicitly false", () => {
      expect(resolveTranscriptsConfig({ enabled: false }).enabled).toBe(false);
    });

    it("is true when explicitly true", () => {
      expect(resolveTranscriptsConfig({ enabled: true }).enabled).toBe(true);
    });

    it("is false for truthy non-boolean values", () => {
      expect(resolveTranscriptsConfig({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
      expect(resolveTranscriptsConfig({ enabled: "true" as unknown as boolean }).enabled).toBe(false);
    });
  });

  describe("maxUtterances", () => {
    it("defaults to 2000 when omitted", () => {
      expect(resolveTranscriptsConfig({}).maxUtterances).toBe(2000);
    });

    it("accepts a positive integer", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: 500 }).maxUtterances).toBe(500);
    });

    it("floors decimal values", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: 3.7 }).maxUtterances).toBe(3);
    });

    it("clamps to minimum of 1", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: 0 }).maxUtterances).toBe(1);
      expect(resolveTranscriptsConfig({ maxUtterances: -5 }).maxUtterances).toBe(1);
    });

    it("clamps to maximum of 10000", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: 20000 }).maxUtterances).toBe(10000);
    });

    it("falls back to default for NaN", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: Number.NaN }).maxUtterances).toBe(2000);
    });

    it("falls back to default for Infinity", () => {
      expect(resolveTranscriptsConfig({ maxUtterances: Infinity }).maxUtterances).toBe(2000);
      expect(resolveTranscriptsConfig({ maxUtterances: -Infinity }).maxUtterances).toBe(2000);
    });

    it("falls back to default for non-number values", () => {
      expect(
        resolveTranscriptsConfig({ maxUtterances: "500" as unknown as number }).maxUtterances,
      ).toBe(2000);
    });
  });

  describe("autoStart", () => {
    it("returns empty array when autoStart is missing", () => {
      expect(resolveTranscriptsConfig({}).autoStart).toEqual([]);
    });

    it("returns empty array when autoStart is not an array", () => {
      expect(resolveTranscriptsConfig({ autoStart: "bad" as unknown as unknown[] }).autoStart).toEqual(
        [],
      );
    });

    it("passes through valid autoStart entries", () => {
      const result = resolveTranscriptsConfig({
        enabled: true,
        autoStart: [
          {
            providerId: "discord",
            sessionId: "s1",
            title: "Daily Standup",
            accountId: "a1",
            guildId: "g1",
            channelId: "c1",
            meetingUrl: "https://meet.example.com/1",
          },
        ],
      });
      expect(result.autoStart).toHaveLength(1);
      expect(result.autoStart[0]).toEqual({
        providerId: "discord",
        sessionId: "s1",
        title: "Daily Standup",
        accountId: "a1",
        guildId: "g1",
        channelId: "c1",
        meetingUrl: "https://meet.example.com/1",
      });
    });

    it("filters out entries without a providerId", () => {
      const result = resolveTranscriptsConfig({
        enabled: true,
        autoStart: [
          { sessionId: "s1", title: "Missing Provider" } as unknown as Record<string, unknown>,
          { providerId: "discord", sessionId: "s2" },
        ],
      });
      expect(result.autoStart).toHaveLength(1);
      expect(result.autoStart[0]?.providerId).toBe("discord");
    });

    it("filters out null and non-object entries in the array", () => {
      const result = resolveTranscriptsConfig({
        autoStart: [null, { providerId: "discord" }, undefined, 123],
      });
      expect(result.autoStart).toHaveLength(1);
      expect(result.autoStart[0]?.providerId).toBe("discord");
    });
  });
});
