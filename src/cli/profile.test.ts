import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

function inheritedEnv(profile = "main", overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const stateDir = `/home/peter/.openclaw${profile === "default" ? "" : `-${profile}`}`;
  return {
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    ...overrides,
  };
}

function selectProfile(env: NodeJS.ProcessEnv, profile = "work") {
  applyCliProfileEnv({ profile, env, homedir: () => "/home/peter" });
}

function expectServiceSelectors(env: NodeJS.ProcessEnv, selectors: (string | undefined)[]) {
  expect([
    env.OPENCLAW_LAUNCHD_LABEL,
    env.OPENCLAW_SYSTEMD_UNIT,
    env.OPENCLAW_WINDOWS_TASK_NAME,
  ]).toEqual(selectors);
}

describe("parseCliProfileArgs", () => {
  it.each<[string[], string | null, string[]?]>([
    [["--no-color", "gateway", "--dev", "--allow-unconfigured"], null],
    [["qa", "matrix", "--profile", "fast", "--fail-fast"], null],
    [
      ["qa", "run", "--profile=release", "--output", "qa-report.md"],
      "release",
      ["qa", "run", "--output", "qa-report.md"],
    ],
  ])(
    "selects the root profile without consuming command-local flags: %j",
    (args, profile, remaining = args) => {
      expect(parseCliProfileArgs(["node", "openclaw", ...args])).toEqual({
        ok: true,
        profile,
        argv: ["node", "openclaw", ...remaining],
      });
    },
  );

  it("rejects missing profile value", () => {
    expect(parseCliProfileArgs(["node", "openclaw", "--profile"]).ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "openclaw", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "openclaw", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    expect(parseCliProfileArgs(argv).ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_PROFILE: "prod",
      OPENCLAW_STATE_DIR: "/custom",
      OPENCLAW_GATEWAY_PORT: "19099",
    };
    selectProfile(env, "dev");
    expect(env).toEqual({
      OPENCLAW_PROFILE: "dev",
      OPENCLAW_STATE_DIR: "/custom",
      OPENCLAW_GATEWAY_PORT: "19099",
      OPENCLAW_CONFIG_PATH: path.join("/custom", "openclaw.json"),
    });
  });

  it("replaces the complete service selector bundle: named service to dev", () => {
    const env = inheritedEnv("main", {
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.main",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-main.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (main)",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    selectProfile(env, "dev");
    expect(env).toMatchObject({
      OPENCLAW_PROFILE: "dev",
      OPENCLAW_STATE_DIR: "/home/peter/.openclaw-dev",
      OPENCLAW_GATEWAY_PORT: "19001",
    });
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expectServiceSelectors(env, [undefined, undefined, undefined]);
  });

  it("preserves node service selectors when selecting a CLI profile", () => {
    const env = inheritedEnv("main", {
      OPENCLAW_GATEWAY_PORT: "19999",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "node",
    });

    selectProfile(env);
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19999");
    expectServiceSelectors(env, ["ai.openclaw.node", "openclaw-node.service", "OpenClaw Node"]);
  });

  it("switches inherited canonical state from the default profile without a marker", () => {
    const env = inheritedEnv("default", { OPENCLAW_PROFILE: undefined });
    selectProfile(env);
    const stateDir = path.join(path.resolve("/home/peter"), ".openclaw-work");
    expect(env).toEqual({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    });
  });

  it("drops inherited canonical service identities when switching profiles", () => {
    const env = inheritedEnv("main", {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.main",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-main",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (main)",
    });
    selectProfile(env);
    expectServiceSelectors(env, [undefined, undefined, undefined]);
  });

  it("keeps case-distinct named profiles isolated (Main to main)", () => {
    const env = inheritedEnv("Main");
    selectProfile(env, "main");
    expect(env).toEqual({
      OPENCLAW_PROFILE: "main",
      OPENCLAW_STATE_DIR: "/home/peter/.openclaw-main",
      OPENCLAW_CONFIG_PATH: path.join("/home/peter/.openclaw-main", "openclaw.json"),
    });
  });
});

describe("formatCliCommand", () => {
  it.each([
    ["Default", "openclaw doctor --fix"],
    ["bad profile", "openclaw doctor --fix"],
    ["dev", "openclaw --dev doctor"],
  ])("returns command unchanged for profile %s: %s", (profile, cmd) => {
    expect(formatCliCommand(cmd, { OPENCLAW_PROFILE: profile })).toBe(cmd);
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "  jbopenclaw  " })).toBe(
      "openclaw --profile jbopenclaw doctor --fix",
    );
  });

  it("ignores unsafe container hints", () => {
    expect(
      formatCliCommand("openclaw gateway status --deep", {
        OPENCLAW_CONTAINER_HINT: "demo; rm -rf /",
      }),
    ).toBe("openclaw gateway status --deep");
  });

  it("preserves the active container for non-root update: pnpm openclaw", () => {
    expect(
      formatCliCommand("pnpm openclaw plugins update telegram", {
        OPENCLAW_CONTAINER_HINT: "demo",
        OPENCLAW_PROFILE: "work",
      }),
    ).toBe("pnpm openclaw --container demo plugins update telegram");
  });
});
