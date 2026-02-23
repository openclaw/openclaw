import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config compaction settings", () => {
  it("preserves memory flush config values", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              reserveTokensFloor: 12_345,
              memoryFlush: {
                enabled: false,
                softThresholdTokens: 1234,
                prompt: "Write notes.",
                systemPrompt: "Flush memory now.",
              },
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();

        expect(cfg.agents?.defaults?.compaction?.reserveTokensFloor).toBe(12_345);
        expect(cfg.agents?.defaults?.compaction?.mode).toBe("safeguard");
        expect(cfg.agents?.defaults?.compaction?.reserveTokens).toBeUndefined();
        expect(cfg.agents?.defaults?.compaction?.keepRecentTokens).toBeUndefined();
        expect(cfg.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(false);
        expect(cfg.agents?.defaults?.compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
        expect(cfg.agents?.defaults?.compaction?.memoryFlush?.prompt).toBe("Write notes.");
        expect(cfg.agents?.defaults?.compaction?.memoryFlush?.systemPrompt).toBe(
          "Flush memory now.",
        );
      },
    );
  });

  it("preserves pi compaction override values", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            compaction: {
              reserveTokens: 15_000,
              keepRecentTokens: 12_000,
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        expect(cfg.agents?.defaults?.compaction?.reserveTokens).toBe(15_000);
        expect(cfg.agents?.defaults?.compaction?.keepRecentTokens).toBe(12_000);
      },
    );
  });

  it("defaults compaction mode to safeguard", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 9000,
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();

        expect(cfg.agents?.defaults?.compaction?.mode).toBe("safeguard");
        expect(cfg.agents?.defaults?.compaction?.reserveTokensFloor).toBe(9000);
      },
    );
  });
});
