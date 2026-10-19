// Tests entrypoint respawn behavior for compile cache and process flags.
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../cli-parent-lifetime.mjs";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

vi.mock("./process/child-process-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process/child-process-bridge.js")>()),
  attachChildProcessBridge: vi.fn(),
}));

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([undefined, "--max-old-space-size=4096"])(
    "suppresses standalone warnings through NODE_OPTIONS while preserving %s",
    (nodeOptions) => {
      vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
      const argv = [
        "bun",
        "/app/runtime/openclaw.mjs",
        "--profile",
        "work",
        "config",
        "get",
        "gateway.mode",
      ];
      const respawnPlan = expectCliRespawnPlan(
        buildPlan({ argv, env: { NODE_OPTIONS: nodeOptions }, platform: "darwin" }),
      );

      expect(respawnPlan.argv).toEqual(argv.slice(2));
      expect(respawnPlan.env.NODE_OPTIONS).toBe(
        nodeOptions ? `${nodeOptions} ${EXPERIMENTAL_WARNING_FLAG}` : EXPERIMENTAL_WARNING_FLAG,
      );
      expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBe("1");
      expect(respawnPlan.env.OPENCLAW_CLI_RESPAWN_PARENT).toBe(String(process.pid));
      expect(buildPlan({ argv, env: respawnPlan.env, platform: "darwin" })).toBeNull();
    },
  );

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

  it("keeps bare-root startup respawns attached to the terminal", () => {
    const plan = buildPlan({
      argv: ["node", "openclaw"],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.argv).toEqual([
      "--import",
      CLI_PARENT_BOUND_PRELOAD,
      EXPERIMENTAL_WARNING_FLAG,
      "openclaw",
    ]);
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
      "--import",
      CLI_PARENT_BOUND_PRELOAD,
      EXPERIMENTAL_WARNING_FLAG,
      "openclaw",
      "cron",
      "list",
      "--json",
    ]);
    expect(respawnPlan.env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it.each([["interactive commands", ["node", "openclaw", "tui"]]] as const)(
    "keeps macOS system CA loading for %s",
    (_label, argv) => {
      expect(
        buildPlan({
          argv: [...argv],
          env: { NODE_USE_SYSTEM_CA: "1" },
          autoNodeExtraCaCerts: undefined,
          platform: "darwin",
        }),
      ).toBeNull();
    },
  );

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
    expect(respawnPlan.argv).toEqual([
      "--import",
      CLI_PARENT_BOUND_PRELOAD,
      "--stack-size=8192",
      scriptPath,
      "node.exe",
      "status",
    ]);
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
      "--import",
      CLI_PARENT_BOUND_PRELOAD,
      EXPERIMENTAL_WARNING_FLAG,
      "/usr/local/bin/openclaw",
      "status",
    ]);
    expect(respawnPlan.detachForProcessTree).toBe(true);
  });
});

describe("runCliRespawnPlan", () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.mocked(attachChildProcessBridge).mockReset();
  });
  it("spawns the standalone plan without adding runtime flags", async () => {
    vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
    try {
      const plan = expectCliRespawnPlan(
        buildPlan({
          argv: [process.execPath, "/app/runtime/openclaw.mjs", "doctor"],
          platform: "darwin",
        }),
      );
      const child = new EventEmitter() as ChildProcess;
      const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
      vi.mocked(attachChildProcessBridge).mockReturnValue({ detach: vi.fn() });
      const completion = runCliRespawnPlan(plan, vi.fn());
      expect(spawn.mock.calls[0]).toEqual([
        process.execPath,
        ["doctor"],
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) }),
        }),
      ]);
      child.emit("close", 0, null);
      await completion;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records status after the respawn child closes", async () => {
    process.exitCode = undefined;
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
    const detach = vi.fn();
    vi.mocked(attachChildProcessBridge).mockReturnValue({ detach });
    const writeError = vi.fn();

    const completion = runCliRespawnPlan(
      {
        command: "/usr/bin/node",
        argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "/repo/openclaw/dist/entry.js", "status"],
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        detachForProcessTree: true,
      },
      writeError,
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["--import", CLI_PARENT_BOUND_PRELOAD, "/repo/openclaw/dist/entry.js", "status"],
      {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        detached: process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
        windowsHide: !(process.stdin.isTTY || process.stdout.isTTY),
      },
    );
    const [bridgeChild, onSignal] = expectDefined<unknown[]>(
      vi.mocked(attachChildProcessBridge).mock.calls[0],
      "child process bridge attach call",
    );
    expect(bridgeChild).toBe(child);
    expect(onSignal).toEqual(expect.any(Function));

    child.emit("exit", 7, null);
    expect(process.exitCode).toBeUndefined();
    child.emit("close", 7, null);
    await completion;
    expect(process.exitCode).toBe(7);
    expect(detach).toHaveBeenCalledOnce();
    expect(writeError).not.toHaveBeenCalled();
  });
});
