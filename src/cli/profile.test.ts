import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "@hanzo/bot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "@hanzo/bot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "@hanzo/bot", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "@hanzo/bot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "@hanzo/bot", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "@hanzo/bot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "@hanzo/bot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "@hanzo/bot", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "@hanzo/bot", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".bot-dev");
    expect(env.BOT_PROFILE).toBe("dev");
    expect(env.BOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.BOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "bot.json"));
    expect(env.BOT_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      BOT_STATE_DIR: "/custom",
      BOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.BOT_STATE_DIR).toBe("/custom");
    expect(env.BOT_GATEWAY_PORT).toBe("19099");
    expect(env.BOT_CONFIG_PATH).toBe(path.join("/custom", "bot.json"));
  });

  it("uses BOT_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      BOT_HOME: "/srv/bot-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/bot-home");
    expect(env.BOT_STATE_DIR).toBe(path.join(resolvedHome, ".bot-work"));
    expect(env.BOT_CONFIG_PATH).toBe(path.join(resolvedHome, ".bot-work", "bot.json"));
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "bot doctor --fix",
      env: {},
      expected: "bot doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "bot doctor --fix",
      env: { BOT_PROFILE: "default" },
      expected: "bot doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "bot doctor --fix",
      env: { BOT_PROFILE: "Default" },
      expected: "bot doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "bot doctor --fix",
      env: { BOT_PROFILE: "bad profile" },
      expected: "bot doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "bot --profile work doctor --fix",
      env: { BOT_PROFILE: "work" },
      expected: "bot --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "bot --dev doctor",
      env: { BOT_PROFILE: "dev" },
      expected: "bot --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("bot doctor --fix", { BOT_PROFILE: "work" })).toBe(
      "bot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("bot doctor --fix", { BOT_PROFILE: "  jbbot  " })).toBe(
      "bot --profile jbbot doctor --fix",
    );
  });

  it("handles command with no args after bot", () => {
    expect(formatCliCommand("@hanzo/bot", { BOT_PROFILE: "test" })).toBe("bot --profile test");
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm bot doctor", { BOT_PROFILE: "work" })).toBe(
      "pnpm bot --profile work doctor",
    );
  });
});
