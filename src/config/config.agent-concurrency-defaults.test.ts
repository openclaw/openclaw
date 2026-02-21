import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveAgentMaxConcurrentPerConversation,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
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

  it("accepts subagent spawn depth and per-agent child limits", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 7,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(parsed.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(7);
  });

  it("resolves per-conversation default when unset", () => {
    expect(resolveAgentMaxConcurrentPerConversation({})).toBe(
      DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
    );
  });

  it("resolves per-conversation value when set", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 3 } },
    };
    expect(resolveAgentMaxConcurrentPerConversation(cfg)).toBe(3);
  });

  it("clamps per-conversation to at least 1", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 0 } },
    };
    expect(resolveAgentMaxConcurrentPerConversation(cfg)).toBe(1);
  });

  it("accepts maxConcurrentPerConversation in schema", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          maxConcurrentPerConversation: 2,
        },
      },
    });
    expect(parsed.agents?.defaults?.maxConcurrentPerConversation).toBe(2);
  });

  it("injects per-conversation default on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();
      expect(cfg.agents?.defaults?.maxConcurrentPerConversation).toBe(
        DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
      );
    });
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
