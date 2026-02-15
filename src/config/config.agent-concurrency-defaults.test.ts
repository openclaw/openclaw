import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_PROVIDER_LIMITS,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
  resolveSubagentProviderLimit,
  resolveSubagentProviderLimits,
} from "./agent-limits.js";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("resolves configured values", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 6,
          subagents: { maxConcurrent: 9 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(6);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(9);
  });

  it("clamps invalid values to at least 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: { maxConcurrent: -3 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });

  it("resolves default provider limits", () => {
    expect(resolveSubagentProviderLimits({})).toEqual(DEFAULT_SUBAGENT_PROVIDER_LIMITS);
    expect(resolveSubagentProviderLimit({}, "openai")).toBe(
      DEFAULT_SUBAGENT_PROVIDER_LIMITS.openai,
    );
    expect(resolveSubagentProviderLimit({}, "custom-provider")).toBe(
      DEFAULT_SUBAGENT_PROVIDER_LIMITS.unknown,
    );
  });

  it("resolves configured provider limits with normalization", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            providerLimits: {
              "g.o_o-gle": 5,
              "z.ai": 2,
              zai: 6,
              unknown: 4,
            },
          },
        },
      },
    };

    const limits = resolveSubagentProviderLimits(cfg);
    expect(limits.google).toBe(5);
    expect(limits.zai).toBe(6);
    expect(limits.unknown).toBe(4);
  });

  it("injects defaults on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
      expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });
  });
});
