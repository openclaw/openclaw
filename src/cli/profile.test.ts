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

const selectorKeys = [
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
];
const gatewaySelectors = ["ai.openclaw.main", "openclaw-gateway-main", "OpenClaw Gateway (main)"];
const nodeSelectors = ["ai.openclaw.node", "openclaw-node.service", "OpenClaw Node"];

function serviceEnv(selectors: string[], kind?: string, port?: string) {
  return inheritedEnv("main", {
    ...Object.fromEntries(selectorKeys.map((key, i) => [key, selectors[i]])),
    ...(kind ? { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: kind } : {}),
    ...(port ? { OPENCLAW_GATEWAY_PORT: port } : {}),
  });
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

  it.each([
    ["gateway", "dev", "19001", undefined],
    ["node", "work", "19999", nodeSelectors],
    [undefined, "work", undefined, undefined],
  ] as const)("isolates profiles from %s service selectors", (kind, profile, port, selectors) => {
    const env = serviceEnv(
      kind === "node" ? nodeSelectors : gatewaySelectors,
      kind,
      kind === "node" ? "19999" : kind === "gateway" ? "18789" : undefined,
    );
    if (kind === "gateway") {
      env.OPENCLAW_SYSTEMD_UNIT += ".service";
    }
    selectProfile(env, profile);
    expect(selectorKeys.map((key) => env[key])).toEqual(
      selectors ?? [undefined, undefined, undefined],
    );
    expect(env.OPENCLAW_GATEWAY_PORT).toBe(port);
    if (kind === "gateway") {
      expect(env).toMatchObject({
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: "/home/peter/.openclaw-dev",
      });
      expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    }
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

  it("classifies repeated global flags in linear time", () => {
    // Root-update detection used to join a flag to its value with `[=\s]+`, so
    // the value matcher could swallow the separator before the next ` --flag`
    // and consume that chunk instead. Repeated chunks then admitted many
    // equivalent splits and classification degraded superlinearly. Keep a
    // wall-clock bound so the ambiguity cannot come back unnoticed.
    const command = `openclaw\t--profile=i${"\t--profile==".repeat(40)}`;
    const startedAt = performance.now();
    expect(formatCliCommand(command, { OPENCLAW_CONTAINER_HINT: "demo" })).toBe(
      command.replace("openclaw", "openclaw --container demo"),
    );
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
