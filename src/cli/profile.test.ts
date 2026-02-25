import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "activi",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "activi", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "activi", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "activi", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "activi", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "activi", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "activi", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "activi", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "activi", "--profile", "work", "--dev", "status"]],
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
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".activi-dev");
    expect(env.ACTIVI_PROFILE).toBe("dev");
    expect(env.ACTIVI_STATE_DIR).toBe(expectedStateDir);
    expect(env.ACTIVI_CONFIG_PATH).toBe(path.join(expectedStateDir, "activi.json"));
    expect(env.ACTIVI_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      ACTIVI_STATE_DIR: "/custom",
      ACTIVI_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.ACTIVI_STATE_DIR).toBe("/custom");
    expect(env.ACTIVI_GATEWAY_PORT).toBe("19099");
    expect(env.ACTIVI_CONFIG_PATH).toBe(path.join("/custom", "activi.json"));
  });

  it("uses ACTIVI_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      ACTIVI_HOME: "/srv/activi-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/activi-home");
    expect(env.ACTIVI_STATE_DIR).toBe(path.join(resolvedHome, ".activi-work"));
    expect(env.ACTIVI_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".activi-work", "activi.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "activi doctor --fix",
      env: {},
      expected: "activi doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "activi doctor --fix",
      env: { ACTIVI_PROFILE: "default" },
      expected: "activi doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "activi doctor --fix",
      env: { ACTIVI_PROFILE: "Default" },
      expected: "activi doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "activi doctor --fix",
      env: { ACTIVI_PROFILE: "bad profile" },
      expected: "activi doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "activi --profile work doctor --fix",
      env: { ACTIVI_PROFILE: "work" },
      expected: "activi --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "activi --dev doctor",
      env: { ACTIVI_PROFILE: "dev" },
      expected: "activi --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("activi doctor --fix", { ACTIVI_PROFILE: "work" })).toBe(
      "activi --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("activi doctor --fix", { ACTIVI_PROFILE: "  jbactivi  " })).toBe(
      "activi --profile jbactivi doctor --fix",
    );
  });

  it("handles command with no args after activi", () => {
    expect(formatCliCommand("activi", { ACTIVI_PROFILE: "test" })).toBe(
      "activi --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm activi doctor", { ACTIVI_PROFILE: "work" })).toBe(
      "pnpm activi --profile work doctor",
    );
  });
});
