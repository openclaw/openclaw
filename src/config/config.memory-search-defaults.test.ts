import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config memory search defaults", () => {
  it("enables session memory indexing, temporal decay, and MMR by default", async () => {
    await withTempHomeConfig({}, async () => {
      const cfg = loadConfig();
      const ms = cfg.agents?.defaults?.memorySearch;

      // Session memory indexing should be on
      expect((ms?.experimental as Record<string, unknown>)?.sessionMemory).toBe(true);
      expect(ms?.sources).toContain("sessions");
      expect(ms?.sources).toContain("memory");

      // Hybrid search with temporal decay
      const hybrid = ms?.query?.hybrid;
      expect(hybrid?.enabled).toBe(true);
      expect(hybrid?.temporalDecay?.enabled).toBe(true);
      expect(hybrid?.temporalDecay?.halfLifeDays).toBe(30);

      // MMR re-ranking
      expect(hybrid?.mmr?.enabled).toBe(true);
      expect(hybrid?.mmr?.lambda).toBe(0.7);
    });
  });

  it("does not overwrite explicit memorySearch config", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            memorySearch: {
              sources: ["memory"],
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        const ms = cfg.agents?.defaults?.memorySearch;

        // User explicitly set sources — respect it, don't inject sessions
        expect(ms?.sources).toEqual(["memory"]);
        expect(ms?.sources).not.toContain("sessions");

        // No defaults injected since user provided explicit config
        expect((ms?.experimental as Record<string, unknown>)?.sessionMemory).toBeUndefined();
      },
    );
  });
});
