import { describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("returns default profile parsing when no args are provided", () => {
    expect(parseCliProfileArgs(["node", "ironclaw"])).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "ironclaw"],
    });
  });

  it("parses --profile and strips profile flags before command execution", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "--profile", "dev", "chat"])).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "ironclaw", "chat"],
    });

    expect(parseCliProfileArgs(["node", "ironclaw", "--profile=team-a", "status"])).toEqual({
      ok: true,
      profile: "team-a",
      argv: ["node", "ironclaw", "status"],
    });
  });

  it("rejects missing, invalid, and conflicting profile inputs", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "--profile"])).toEqual({
      ok: false,
      error: "--profile requires a value",
    });

    expect(parseCliProfileArgs(["node", "ironclaw", "--profile", "bad profile"])).toEqual({
      ok: false,
      error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
    });

    expect(parseCliProfileArgs(["node", "ironclaw", "--dev", "--profile", "team-a"])).toEqual({
      ok: false,
      error: "Cannot combine --dev with --profile",
    });
  });

  it("stops profile parsing once command path begins", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "chat", "--profile", "dev"])).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "ironclaw", "chat", "--profile", "dev"],
    });
  });
});

describe("applyCliProfileEnv", () => {
  it("fills profile defaults without overriding explicit state/config vars", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "team-a",
      env,
      homedir: () => "/tmp/home",
    });

    expect(env.OPENCLAW_PROFILE).toBe("team-a");
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/home/.openclaw-team-a");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/tmp/home/.openclaw-team-a/openclaw.json");
  });

  it("respects explicit state/config paths and assigns dev gateway port when absent", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_STATE_DIR: "/custom/state",
      OPENCLAW_CONFIG_PATH: "/custom/state/openclaw.json",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/tmp/home",
    });

    expect(env.OPENCLAW_STATE_DIR).toBe("/custom/state");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/custom/state/openclaw.json");
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19001");
  });
});
