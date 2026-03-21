import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config memory search defaults", () => {
  it("enables session memory indexing, temporal decay, and MMR by default", async () => {
    await withTempHomeConfig({}, async () => {
      const cfg = loadConfig();
      const ms = cfg.agents?.defaults?.memorySearch;

      expect((ms?.experimental as Record<string, unknown>)?.sessionMemory).toBe(true);
      expect(ms?.sources).toContain("sessions");
      expect(ms?.sources).toContain("memory");

      const hybrid = ms?.query?.hybrid;
      expect(hybrid?.enabled).toBe(true);
      expect(hybrid?.temporalDecay?.enabled).toBe(true);
      expect(hybrid?.temporalDecay?.halfLifeDays).toBe(30);
      expect(hybrid?.mmr?.enabled).toBe(true);
      expect(hybrid?.mmr?.lambda).toBe(0.7);
    });
  });

  it("still applies hybrid defaults when user only sets an unrelated field like provider", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            memorySearch: {
              provider: "openai",
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        const ms = cfg.agents?.defaults?.memorySearch;

        // User's explicit field preserved
        expect(ms?.provider).toBe("openai");

        // Smart defaults still applied — user only set provider, not these
        expect((ms?.experimental as Record<string, unknown>)?.sessionMemory).toBe(true);
        expect(ms?.sources).toContain("sessions");
        expect(ms?.query?.hybrid?.temporalDecay?.enabled).toBe(true);
        expect(ms?.query?.hybrid?.mmr?.enabled).toBe(true);
      },
    );
  });

  it("does not overwrite explicit sources config", async () => {
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

        // User explicitly restricted sources — respect it
        expect(ms?.sources).toEqual(["memory"]);
        expect(ms?.sources).not.toContain("sessions");

        // Hybrid defaults still applied since query.hybrid wasn't set
        expect(ms?.query?.hybrid?.temporalDecay?.enabled).toBe(true);
      },
    );
  });

  it("does not overwrite explicit query.hybrid config", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            memorySearch: {
              query: {
                hybrid: {
                  enabled: false,
                },
              },
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        const ms = cfg.agents?.defaults?.memorySearch;

        // User explicitly disabled hybrid — respect it, don't inject our defaults
        expect(ms?.query?.hybrid?.enabled).toBe(false);
        expect(ms?.query?.hybrid?.temporalDecay).toBeUndefined();
        expect(ms?.query?.hybrid?.mmr).toBeUndefined();

        // Session indexing defaults still applied since sources/experimental weren't set
        expect((ms?.experimental as Record<string, unknown>)?.sessionMemory).toBe(true);
      },
    );
  });
});
