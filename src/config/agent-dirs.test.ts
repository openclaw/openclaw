// Covers agent directory resolution across config and environment overrides.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

describe("findDuplicateAgentDirs", () => {
  it("finds duplicate explicit dirs in keyed agent entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          alpha: { default: true, agentDir: "/srv/shared-agent" },
          beta: { agentDir: "/srv/shared-agent" },
        },
      },
    };

    expect(findDuplicateAgentDirs(cfg)).toEqual([
      { agentDir: "/srv/shared-agent", agentIds: ["alpha", "beta"] },
    ]);
  });

  it.each([
    {
      name: "OPENCLAW_HOME",
      env: { OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" },
      stateDir: "/srv/openclaw-home/.openclaw",
    },
    {
      name: "OPENCLAW_STATE_DIR",
      env: { OPENCLAW_STATE_DIR: "/srv/openclaw-state", OPENCLAW_HOME: "/home/other" },
      stateDir: "/srv/openclaw-state",
    },
    {
      name: "the supplied home resolver",
      env: {},
      stateDir: "/srv/fallback-home/.openclaw",
    },
  ])("detects a configured directory colliding with $name", ({ env, stateDir }) => {
    const agentDir = path.resolve(stateDir, "agents", "alpha", "agent");
    const cfg: OpenClawConfig = {
      agents: { entries: { alpha: {}, beta: { agentDir } } },
    };

    expect(findDuplicateAgentDirs(cfg, { env, homedir: () => "/srv/fallback-home" })).toEqual([
      { agentDir, agentIds: ["alpha", "beta"] },
    ]);
  });
});
