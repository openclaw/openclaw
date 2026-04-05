import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "mullusi",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "mullusi", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("leaves gateway --dev for subcommands after leading root options", () => {
    const res = parseCliProfileArgs([
      "node",
      "mullusi",
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
      "mullusi",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "mullusi", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "mullusi", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "mullusi", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "mullusi", "status"]);
  });

  it("parses interleaved --profile after the command token", () => {
    const res = parseCliProfileArgs(["node", "mullusi", "status", "--profile", "work", "--deep"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "mullusi", "status", "--deep"]);
  });

  it("parses interleaved --dev after the command token", () => {
    const res = parseCliProfileArgs(["node", "mullusi", "status", "--dev"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "mullusi", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "mullusi", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "mullusi", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "mullusi", "--profile", "work", "--dev", "status"]],
    ["interleaved after command", ["node", "mullusi", "status", "--profile", "work", "--dev"]],
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
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".mullusi-dev");
    expect(env.MULLUSI_PROFILE).toBe("dev");
    expect(env.MULLUSI_STATE_DIR).toBe(expectedStateDir);
    expect(env.MULLUSI_CONFIG_PATH).toBe(path.join(expectedStateDir, "mullusi.json"));
    expect(env.MULLUSI_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      MULLUSI_STATE_DIR: "/custom",
      MULLUSI_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.MULLUSI_STATE_DIR).toBe("/custom");
    expect(env.MULLUSI_GATEWAY_PORT).toBe("19099");
    expect(env.MULLUSI_CONFIG_PATH).toBe(path.join("/custom", "mullusi.json"));
  });

  it("uses MULLUSI_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      MULLUSI_HOME: "/srv/mullusi-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/mullusi-home");
    expect(env.MULLUSI_STATE_DIR).toBe(path.join(resolvedHome, ".mullusi-work"));
    expect(env.MULLUSI_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".mullusi-work", "mullusi.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "mullusi doctor --fix",
      env: {},
      expected: "mullusi doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "mullusi doctor --fix",
      env: { MULLUSI_PROFILE: "default" },
      expected: "mullusi doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "mullusi doctor --fix",
      env: { MULLUSI_PROFILE: "Default" },
      expected: "mullusi doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "mullusi doctor --fix",
      env: { MULLUSI_PROFILE: "bad profile" },
      expected: "mullusi doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "mullusi --profile work doctor --fix",
      env: { MULLUSI_PROFILE: "work" },
      expected: "mullusi --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "mullusi --dev doctor",
      env: { MULLUSI_PROFILE: "dev" },
      expected: "mullusi --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("mullusi doctor --fix", { MULLUSI_PROFILE: "work" })).toBe(
      "mullusi --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("mullusi doctor --fix", { MULLUSI_PROFILE: "  jbmullusi  " })).toBe(
      "mullusi --profile jbmullusi doctor --fix",
    );
  });

  it("handles command with no args after mullusi", () => {
    expect(formatCliCommand("mullusi", { MULLUSI_PROFILE: "test" })).toBe(
      "mullusi --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm mullusi doctor", { MULLUSI_PROFILE: "work" })).toBe(
      "pnpm mullusi --profile work doctor",
    );
  });

  it("inserts --container when a container hint is set", () => {
    expect(
      formatCliCommand("mullusi gateway status --deep", { MULLUSI_CONTAINER_HINT: "demo" }),
    ).toBe("mullusi --container demo gateway status --deep");
  });

  it("preserves both --container and --profile hints", () => {
    expect(
      formatCliCommand("mullusi doctor", {
        MULLUSI_CONTAINER_HINT: "demo",
        MULLUSI_PROFILE: "work",
      }),
    ).toBe("mullusi --container demo doctor");
  });

  it("does not prepend --container for update commands", () => {
    expect(formatCliCommand("mullusi update", { MULLUSI_CONTAINER_HINT: "demo" })).toBe(
      "mullusi update",
    );
    expect(
      formatCliCommand("pnpm mullusi update --channel beta", { MULLUSI_CONTAINER_HINT: "demo" }),
    ).toBe("pnpm mullusi update --channel beta");
  });
});
