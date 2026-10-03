// Tests entrypoint respawn behavior for compile cache and process flags.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";

const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";

type CliRespawnPlan = NonNullable<ReturnType<typeof buildCliRespawnPlan>>;

function expectCliRespawnPlan(plan: ReturnType<typeof buildCliRespawnPlan>): CliRespawnPlan {
  if (plan === null) {
    throw new Error("Expected CLI respawn plan");
  }
  return plan;
}

function buildPlan(params: Parameters<typeof buildCliRespawnPlan>[0]) {
  return buildCliRespawnPlan({ env: {}, execArgv: [], ...params });
}

describe("buildCliRespawnPlan", () => {
  it("returns null when respawn policy skips the argv", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "--help"],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      }),
    ).toBeNull();
  });

  it.each([
    ["gateway", "run", "--ambient-channels"],
    ["gateway", "--ambient-channels", "run"],
    ["gateway", "run", "--dev-ambient-channels"],
  ])("keeps foreground Gateway ambient channel options in process: %j", (...args) => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        buildPlan({
          argv: ["node", "openclaw", ...args],
          autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
          platform,
        }),
      ).toBeNull();
    }
  });

  it("does not detach native hook relays through a startup respawn", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "hooks", "relay", "--relay-id", "relay-1"],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
        platform: "linux",
      }),
    ).toBeNull();
  });

  it.each(["linux", "win32"] as const)(
    "leaves foreground Gmail shutdown with its lifecycle owner on %s",
    (platform) => {
      for (const args of [
        ["webhooks", "gmail", "run", "--account", "fixture@example.com"],
        ["--profile", "fixture", "webhooks", "gmail", "run"],
      ]) {
        expect(
          buildPlan({
            argv: ["node", "openclaw", ...args],
            autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
            platform,
          }),
        ).toBeNull();
      }
      expect(
        buildPlan({
          argv: ["node", "openclaw", "webhooks", "gmail", "setup"],
          platform,
        }),
      ).not.toBeNull();
    },
  );

  it("adds NODE_EXTRA_CA_CERTS and warning suppression in one respawn", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "status"],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.command).toBe(process.execPath);
    expect(respawnPlan.argv[0]).toBe(EXPERIMENTAL_WARNING_FLAG);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe("1");
    expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBe("1");
    expect(respawnPlan.detachForProcessTree).toBe(true);
  });

  it("does not respawn gateway status only to suppress warnings", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "gateway", "status", "--json"],
        autoNodeExtraCaCerts: undefined,
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("preserves NODE_EXTRA_CA_CERTS respawn for gateway status", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "gateway", "status", "--json"],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual(["openclaw", "gateway", "status", "--json"]);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe("1");
    expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBeUndefined();
    expect(respawnPlan.detachForProcessTree).toBe(true);
  });

  it("preserves NODE_EXTRA_CA_CERTS respawn for interactive commands", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "tui"],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual(["openclaw", "tui"]);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe("1");
    expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBeUndefined();
    expect(respawnPlan.detachForProcessTree).toBe(false);
  });

  it("keeps bare-root startup respawns attached to the terminal", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw"],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual([EXPERIMENTAL_WARNING_FLAG, "openclaw"]);
    expect(respawnPlan.detachForProcessTree).toBe(false);
  });

  it("preserves macOS system CA trust through one-shot warning respawns", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "cron", "list", "--json"],
      env: { NODE_USE_SYSTEM_CA: "1" },
      autoNodeExtraCaCerts: undefined,
      platform: "darwin",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual([
      EXPERIMENTAL_WARNING_FLAG,
      "openclaw",
      "cron",
      "list",
      "--json",
    ]);
    expect(respawnPlan.env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it.each([
    ["interactive commands", ["node", "openclaw", "tui"]],
    ["the foreground Gateway", ["node", "openclaw", "gateway", "run"]],
  ] as const)("keeps macOS system CA loading for %s", (_label, argv) => {
    expect(
      buildPlan({
        argv: [...argv],
        env: { NODE_USE_SYSTEM_CA: "1" },
        autoNodeExtraCaCerts: undefined,
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("does not respawn one-shot commands only to change CA trust", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "cron", "list", "--json"],
        env: {
          NODE_USE_SYSTEM_CA: "1",
          [OPENCLAW_NODE_OPTIONS_READY]: "1",
        },
        execArgv: [EXPERIMENTAL_WARNING_FLAG],
        autoNodeExtraCaCerts: undefined,
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("does not respawn interactive commands for warning suppression only", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "tui"],
        env: { [OPENCLAW_NODE_EXTRA_CA_CERTS_READY]: "1" },
        autoNodeExtraCaCerts: undefined,
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("does not overwrite an existing NODE_EXTRA_CA_CERTS value", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "status"],
      env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" },
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/custom/ca.pem");
  });

  it.each([
    ["injects a discovered CA for whitespace", "linux", " ", "/etc/ca.pem", "/etc/ca.pem", "1"],
    ["drops whitespace without discovery", "linux", " ", undefined, undefined, undefined],
    ["drops whitespace on Windows", "win32", " ", undefined, undefined, undefined],
  ] as const)("%s", (_label, platform, inherited, discovered, expected, expectedReady) => {
    const plan = buildPlan({
      argv: ["node", "openclaw", "status"],
      env: { NODE_EXTRA_CA_CERTS: inherited },
      autoNodeExtraCaCerts: discovered,
      platform,
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe(expected);
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe(expectedReady);
  });

  it("returns null when both respawn guards are already satisfied", () => {
    expect(
      buildPlan({
        argv: ["node", "openclaw", "status"],
        env: {
          [OPENCLAW_NODE_EXTRA_CA_CERTS_READY]: "1",
          [OPENCLAW_NODE_OPTIONS_READY]: "1",
        },
        execArgv: [EXPERIMENTAL_WARNING_FLAG],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("adds a larger V8 stack size on Windows", () => {
    const plan = buildPlan({
      argv: [
        "node",
        "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
        "dashboard",
      ],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "win32",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual([
      "--stack-size=8192",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
      "dashboard",
    ]);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBeUndefined();
    expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBeUndefined();
    expect(respawnPlan.detachForProcessTree).toBe(false);
  });

  it("preserves post-script node.exe arguments after normalizing the launcher prefix", () => {
    const scriptPath =
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
    const plan = buildPlan({
      argv: [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files\\nodejs\\node.exe",
        scriptPath,
        "node.exe",
        "status",
      ],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual(["--stack-size=8192", scriptPath, "node.exe", "status"]);
  });

  it("does not respawn on Windows when stack size is already configured", () => {
    expect(
      buildPlan({
        argv: [
          "node",
          "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
          "dashboard",
        ],
        execArgv: ["--stack-size=16384"],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("does not respawn on Windows when underscore stack size spelling is already configured", () => {
    expect(
      buildPlan({
        argv: [
          "node",
          "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
          "dashboard",
        ],
        execArgv: ["--stack_size=16384"],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("respawns Volta shims through node so the shim is not called directly", () => {
    const plan = buildPlan({
      argv: ["/home/alice/.volta/bin/volta-shim", "/usr/local/bin/openclaw", "status"],
      env: { PATH: "/home/alice/.volta/bin:/usr/bin:/bin" },
      execPath: "/home/alice/.volta/bin/volta-shim",
      autoNodeExtraCaCerts: undefined,
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.command).toBe("node");
    expect(respawnPlan.argv).toEqual([
      EXPERIMENTAL_WARNING_FLAG,
      "/usr/local/bin/openclaw",
      "status",
    ]);
    expect(respawnPlan.detachForProcessTree).toBe(true);
  });
});

describe("runCliRespawnPlan", () => {
  it("spawns and bridges the respawn child", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const attachChildProcessBridge = vi.fn();
    const exit = vi.fn<(code?: number) => never>();
    const writeError = vi.fn();

    runCliRespawnPlan(
      {
        command: "/usr/bin/node",
        argv: ["/repo/openclaw/dist/entry.js", "status"],
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        detachForProcessTree: true,
      },
      {
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
        attachChildProcessBridge,
        exit,
        writeError,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/repo/openclaw/dist/entry.js", "status"],
      {
        stdio: "inherit",
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        detached: process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
        windowsHide: !(process.stdin.isTTY || process.stdout.isTTY),
      },
    );
    const [bridgeChild, bridgeOptions] = expectDefined<unknown[]>(
      attachChildProcessBridge.mock.calls[0],
      "child process bridge attach call",
    );
    expect(bridgeChild).toBe(child);
    expect(bridgeOptions).toEqual({ onSignal: expect.any(Function) });

    child.emit("exit", 0, null);

    expect(exit).toHaveBeenCalledWith(0);
    expect(writeError).not.toHaveBeenCalled();
  });
});
