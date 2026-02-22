import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs, resolveEffectiveCliProfile } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "openclaw", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "openclaw", "gateway"]);
  });

  it("parses --profile after subcommand", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "gateway",
      "--profile",
      "invest",
      "--port",
      "18795",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("invest");
    expect(res.argv).toEqual(["node", "openclaw", "gateway", "--port", "18795"]);
  });

  it("parses --profile=NAME after subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "gateway", "--profile=work"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "gateway"]);
  });

  it("keeps --dev and strips --profile when both appear after subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "gateway", "--dev", "--profile", "work"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "gateway", "--dev"]);
  });

  it("rejects --dev before subcommand combined with --profile after subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--dev", "gateway", "--profile", "work"]);
    expect(res.ok).toBe(false);
  });

  it("does not intercept --profile after passthrough terminator", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "nodes",
      "run",
      "--node",
      "abc123",
      "--",
      "aws",
      "--profile",
      "prod",
      "sts",
      "get-caller-identity",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "openclaw",
      "nodes",
      "run",
      "--node",
      "abc123",
      "--",
      "aws",
      "--profile",
      "prod",
      "sts",
      "get-caller-identity",
    ]);
  });

  it("keeps passthrough --profile when global --profile is set before terminator", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "--profile",
      "work",
      "nodes",
      "run",
      "--",
      "aws",
      "--profile=prod",
      "sts",
      "get-caller-identity",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual([
      "node",
      "openclaw",
      "nodes",
      "run",
      "--",
      "aws",
      "--profile=prod",
      "sts",
      "get-caller-identity",
    ]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "openclaw", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "openclaw", "--profile", "work", "--dev", "status"]],
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
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".openclaw-dev");
    expect(env.OPENCLAW_PROFILE).toBe("dev");
    expect(env.OPENCLAW_STATE_DIR).toBe(expectedStateDir);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "openclaw.json"));
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit OPENCLAW_STATE_DIR env value", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_STATE_DIR: "/custom",
      OPENCLAW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("/custom");
    // OPENCLAW_GATEWAY_PORT is intentionally reset for profile isolation.
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19001");
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join("/custom", "openclaw.json"));
  });

  it("clears inherited OPENCLAW_GATEWAY_PORT for non-dev profiles", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_GATEWAY_PORT: "18789",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.OPENCLAW_GATEWAY_PORT).toBeUndefined();
  });

  it("clears inherited service env vars for profile isolation", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      OPENCLAW_SERVICE_VERSION: "2026.1.0",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.OPENCLAW_GATEWAY_PORT).toBeUndefined();
    expect(env.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBeUndefined();
    expect(env.OPENCLAW_SERVICE_VERSION).toBeUndefined();
    expect(env.OPENCLAW_PROFILE).toBe("work");
  });

  it("uses OPENCLAW_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/openclaw-home");
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(resolvedHome, ".openclaw-work"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".openclaw-work", "openclaw.json"),
    );
  });
});

describe("resolveEffectiveCliProfile", () => {
  it("prefers parsed profile over env profile", () => {
    const res = resolveEffectiveCliProfile({
      parsedProfile: "work",
      envProfile: "dev",
    });
    expect(res).toEqual({ ok: true, profile: "work" });
  });

  it("falls back to env profile when parsed profile is absent", () => {
    const res = resolveEffectiveCliProfile({
      parsedProfile: null,
      envProfile: "dev",
    });
    expect(res).toEqual({ ok: true, profile: "dev" });
  });

  it("treats blank env profile as unset", () => {
    const res = resolveEffectiveCliProfile({
      parsedProfile: null,
      envProfile: "   ",
    });
    expect(res).toEqual({ ok: true, profile: null });
  });

  it("rejects invalid env profile values", () => {
    const res = resolveEffectiveCliProfile({
      parsedProfile: null,
      envProfile: "bad profile",
    });
    expect(res.ok).toBe(false);
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "openclaw doctor --fix",
      env: {},
      expected: "openclaw doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "default" },
      expected: "openclaw doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "Default" },
      expected: "openclaw doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "bad profile" },
      expected: "openclaw doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "openclaw --profile work doctor --fix",
      env: { OPENCLAW_PROFILE: "work" },
      expected: "openclaw --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "openclaw --dev doctor",
      env: { OPENCLAW_PROFILE: "dev" },
      expected: "openclaw --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "work" })).toBe(
      "openclaw --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "  jbopenclaw  " })).toBe(
      "openclaw --profile jbopenclaw doctor --fix",
    );
  });

  it("handles command with no args after openclaw", () => {
    expect(formatCliCommand("openclaw", { OPENCLAW_PROFILE: "test" })).toBe(
      "openclaw --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm openclaw doctor", { OPENCLAW_PROFILE: "work" })).toBe(
      "pnpm openclaw --profile work doctor",
    );
  });
});
