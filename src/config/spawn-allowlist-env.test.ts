import { describe, expect, it } from "vitest";
import {
  applySpawnAllowlistEnvOverlay,
  resolveSpawnAllowlistFromProcessEnv,
} from "./spawn-allowlist-env.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("resolveSpawnAllowlistFromProcessEnv", () => {
  it("reads OPENCLAW_SPAWN_ALLOWLIST", () => {
    expect(resolveSpawnAllowlistFromProcessEnv({ OPENCLAW_SPAWN_ALLOWLIST: "*" })).toEqual(["*"]);
  });

  it("falls back to SPAWN_ALLOWLIST", () => {
    expect(resolveSpawnAllowlistFromProcessEnv({ SPAWN_ALLOWLIST: "*" })).toEqual(["*"]);
  });

  it("parses comma-separated ids", () => {
    expect(resolveSpawnAllowlistFromProcessEnv({ SPAWN_ALLOWLIST: " alpha, beta " })).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("parses JSON string arrays", () => {
    expect(resolveSpawnAllowlistFromProcessEnv({ SPAWN_ALLOWLIST: '["a","b"]' })).toEqual([
      "a",
      "b",
    ]);
  });

  it("prefers OPENCLAW_ over unprefixed", () => {
    expect(
      resolveSpawnAllowlistFromProcessEnv({
        OPENCLAW_SPAWN_ALLOWLIST: "fast",
        SPAWN_ALLOWLIST: "slow",
      }),
    ).toEqual(["fast"]);
  });
});

describe("applySpawnAllowlistEnvOverlay", () => {
  it("writes agents.defaults.subagents.allowAgents when env set", () => {
    const cfg = {} as OpenClawConfig;
    applySpawnAllowlistEnvOverlay(cfg, { SPAWN_ALLOWLIST: "*" });
    expect(cfg.agents?.defaults?.subagents?.allowAgents).toEqual(["*"]);
  });

  it("overwrites existing config allowAgents when env set (Docker precedence)", () => {
    const cfg = {
      agents: { defaults: { subagents: { allowAgents: ["legacy"] } } },
    } as OpenClawConfig;
    applySpawnAllowlistEnvOverlay(cfg, { SPAWN_ALLOWLIST: "x,y" });
    expect(cfg.agents?.defaults?.subagents?.allowAgents).toEqual(["x", "y"]);
  });

  it("noop when unset", () => {
    const cfg = { agents: { defaults: {} } } as OpenClawConfig;
    applySpawnAllowlistEnvOverlay(cfg, {});
    expect(cfg.agents?.defaults?.subagents?.allowAgents).toBeUndefined();
  });
});
