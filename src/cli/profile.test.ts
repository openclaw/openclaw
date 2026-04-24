import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

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

  it("leaves gateway --dev for subcommands after leading root options", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "openclaw",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "openclaw", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "status"]);
  });

  it("parses interleaved --profile after the command token", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "status", "--profile", "work", "--deep"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "status", "--deep"]);
  });

  it("parses interleaved --dev after the command token", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "status", "--dev"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "openclaw", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "openclaw", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "openclaw", "--profile", "work", "--dev", "status"]],
    ["interleaved after command", ["node", "openclaw", "status", "--profile", "work", "--dev"]],
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

  it("does not override explicit env values", () => {
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
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19099");
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join("/custom", "openclaw.json"));
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

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "openclaw doctor --fix",
      env: {},
      expected: "gemmaclaw doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "default" },
      expected: "gemmaclaw doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "Default" },
      expected: "gemmaclaw doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "bad profile" },
      expected: "gemmaclaw doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "openclaw --profile work doctor --fix",
      env: { OPENCLAW_PROFILE: "work" },
      expected: "gemmaclaw --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "openclaw --dev doctor",
      env: { OPENCLAW_PROFILE: "dev" },
      expected: "gemmaclaw --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "work" })).toBe(
      "gemmaclaw --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "  jbopenclaw  " })).toBe(
      "gemmaclaw --profile jbopenclaw doctor --fix",
    );
  });

  it("handles command with no args after openclaw", () => {
    expect(formatCliCommand("openclaw", { OPENCLAW_PROFILE: "test" })).toBe(
      "gemmaclaw --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm openclaw doctor", { OPENCLAW_PROFILE: "work" })).toBe(
      "pnpm gemmaclaw --profile work doctor",
    );
  });

  it("inserts --container when a container hint is set", () => {
    expect(
      formatCliCommand("openclaw gateway status --deep", { OPENCLAW_CONTAINER_HINT: "demo" }),
    ).toBe("gemmaclaw --container demo gateway status --deep");
  });

  it("ignores unsafe container hints", () => {
    expect(
      formatCliCommand("openclaw gateway status --deep", {
        OPENCLAW_CONTAINER_HINT: "demo; rm -rf /",
      }),
    ).toBe("gemmaclaw gateway status --deep");
  });

  it("preserves both --container and --profile hints", () => {
    expect(
      formatCliCommand("openclaw doctor", {
        OPENCLAW_CONTAINER_HINT: "demo",
        OPENCLAW_PROFILE: "work",
      }),
    ).toBe("gemmaclaw --container demo doctor");
  });

  it("does not prepend --container for update commands", () => {
    expect(formatCliCommand("openclaw update", { OPENCLAW_CONTAINER_HINT: "demo" })).toBe(
      "gemmaclaw update",
    );
    expect(
      formatCliCommand("pnpm openclaw update --channel beta", { OPENCLAW_CONTAINER_HINT: "demo" }),
    ).toBe("pnpm gemmaclaw update --channel beta");
  });
});
