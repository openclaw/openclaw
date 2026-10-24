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
  const argv = (args: string) => ["node", "openclaw", ...args.split(" ")];
  it.each<[string, string | null, string?]>([
    ["--no-color gateway --dev --allow-unconfigured", null],
    ["qa matrix --profile fast --fail-fast", null],
    ["qa run --profile=release --output qa-report.md", "release", "qa run --output qa-report.md"],
  ])(
    "selects the root profile without consuming command-local flags: %j",
    (args, profile, remaining = args) => {
      expect(parseCliProfileArgs(argv(args))).toEqual({
        ok: true,
        profile,
        argv: argv(remaining),
      });
    },
  );

  it.each(["--profile", "--dev --profile work status", "--profile work --dev status"])(
    "rejects invalid profile options: %s",
    (args) => {
      expect(parseCliProfileArgs(argv(args)).ok).toBe(false);
    },
  );
});

describe("applyCliProfileEnv", () => {
  const workStateDir = path.join(path.resolve("/home/peter"), ".openclaw-work");
  it.each<[string, NodeJS.ProcessEnv, string, NodeJS.ProcessEnv]>([
    [
      "explicit paths",
      { OPENCLAW_PROFILE: "prod", OPENCLAW_STATE_DIR: "/custom", OPENCLAW_GATEWAY_PORT: "19099" },
      "dev",
      {
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: "/custom",
        OPENCLAW_GATEWAY_PORT: "19099",
        OPENCLAW_CONFIG_PATH: path.join("/custom", "openclaw.json"),
      },
    ],
    [
      "unmarked default profile",
      inheritedEnv("default", { OPENCLAW_PROFILE: undefined }),
      "work",
      inheritedEnv("work", {
        OPENCLAW_STATE_DIR: workStateDir,
        OPENCLAW_CONFIG_PATH: path.join(workStateDir, "openclaw.json"),
      }),
    ],
    ["case-distinct profile", inheritedEnv("Main"), "main", inheritedEnv("main")],
  ])("switches %s without leaking another profile's paths", (_name, env, profile, expected) => {
    selectProfile(env, profile);
    expect(env).toEqual(expected);
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

  it("drops inherited canonical service identities when switching profiles", () => {
    const env = inheritedEnv("main", {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.main",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-main",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (main)",
    });
    selectProfile(env);
    expectServiceSelectors(env, [undefined, undefined, undefined]);
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
