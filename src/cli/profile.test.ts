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

  it.each([
    ["--profile"],
    ["--dev", "--profile", "work", "status"],
    ["--profile", "work", "--dev", "status"],
  ])("rejects invalid profile options: %j", (...args) => {
    expect(parseCliProfileArgs(["node", "openclaw", ...args]).ok).toBe(false);
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
  it.each<[string, NodeJS.ProcessEnv, string?]>([
    ["openclaw doctor --fix", { OPENCLAW_PROFILE: "Default" }],
    ["openclaw doctor --fix", { OPENCLAW_PROFILE: "bad profile" }],
    ["openclaw --dev doctor", { OPENCLAW_PROFILE: "dev" }],
    [
      "openclaw doctor --fix",
      { OPENCLAW_PROFILE: "  jbopenclaw  " },
      "openclaw --profile jbopenclaw doctor --fix",
    ],
    ["openclaw gateway status --deep", { OPENCLAW_CONTAINER_HINT: "demo; rm -rf /" }],
    [
      "pnpm openclaw plugins update telegram",
      { OPENCLAW_CONTAINER_HINT: "demo", OPENCLAW_PROFILE: "work" },
      "pnpm openclaw --container demo plugins update telegram",
    ],
  ])("formats %s with %j", (cmd, env, expected = cmd) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });
});
