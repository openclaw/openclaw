import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../cli-parent-lifetime.mjs";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

vi.mock("./process/child-process-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process/child-process-bridge.js")>()),
  attachChildProcessBridge: vi.fn(),
}));

const warningFlag = "--disable-warning=ExperimentalWarning";
const caReady = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const optionsReady = "OPENCLAW_NODE_OPTIONS_READY";

type PlanOptions = NonNullable<Parameters<typeof buildCliRespawnPlan>[0]> & { args?: string[] };
function buildPlan({ args = ["status"], ...params }: PlanOptions) {
  return buildCliRespawnPlan({
    argv: ["node", "openclaw", ...args],
    env: {},
    execArgv: [],
    platform: "linux",
    ...params,
  });
}

function requirePlan(params: Parameters<typeof buildPlan>[0]) {
  return expectDefined(buildPlan(params), "Expected CLI respawn plan");
}

const warningPrefix = ["--import", CLI_PARENT_BOUND_PRELOAD, warningFlag];
const systemCa = "/etc/ssl/certs/ca-certificates.crt";
const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
const windowsScript =
  "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
const windowsTail = [windowsScript, "node.exe", "status"];
const voltaShim = "/home/alice/.volta/bin/volta-shim";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.mocked(attachChildProcessBridge).mockReset();
  vi.unstubAllGlobals();
});

it.each([undefined, "--max-old-space-size=4096"])(
  "suppresses standalone warnings through NODE_OPTIONS while preserving %s",
  (nodeOptions) => {
    vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
    const args = ["--profile", "work", "config", "get", "gateway.mode"];
    const argv = ["bun", "/app/runtime/openclaw.mjs", ...args];
    const respawnPlan = requirePlan({
      argv,
      env: { NODE_OPTIONS: nodeOptions },
      platform: "darwin",
    });

    expect(respawnPlan).toMatchObject({
      argv: args,
      env: {
        NODE_OPTIONS: nodeOptions ? `${nodeOptions} ${warningFlag}` : warningFlag,
        [optionsReady]: "1",
        OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid),
      },
    });
    expect(buildPlan({ argv, env: respawnPlan.env, platform: "darwin" })).toBeNull();
  },
);

it.each(["linux", "win32"] as const)(
  "leaves foreground Gmail shutdown with its lifecycle owner on %s",
  (platform) => {
    const plan = (args: string[], ca?: string) =>
      buildPlan({ args, platform, autoNodeExtraCaCerts: ca });
    for (const args of [
      ["webhooks", "gmail", "run", "--account", "fixture@example.com"],
      ["--profile", "fixture", "webhooks", "gmail", "run"],
    ]) {
      expect(plan(args, systemCa)).toBeNull();
    }
    expect(plan(["webhooks", "gmail", "setup"])).not.toBeNull();
  },
);

it.each([
  [
    "bare-root startup stays attached to the terminal",
    { args: [], autoNodeExtraCaCerts: systemCa },
    { argv: [...warningPrefix, "openclaw"], detachForProcessTree: false },
  ],
  [
    "macOS system CA trust survives one-shot warning respawns",
    {
      args: ["cron", "list", "--json"],
      env: { NODE_USE_SYSTEM_CA: "1" },
      platform: "darwin",
    },
    {
      argv: [...warningPrefix, "openclaw", "cron", "list", "--json"],
      env: { NODE_USE_SYSTEM_CA: "1" },
    },
  ],
  [
    "explicit NODE_EXTRA_CA_CERTS survives discovery",
    { env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" }, autoNodeExtraCaCerts: systemCa },
    { env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" } },
  ],
  [
    "Windows normalization preserves post-script node.exe arguments",
    {
      argv: [windowsNode, windowsNode, ...windowsTail],
      execPath: windowsNode,
      platform: "win32",
    },
    {
      argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "--stack-size=8192", ...windowsTail],
      detachForProcessTree: false,
    },
  ],
  [
    "Volta shims respawn through node instead of calling the shim",
    {
      argv: [voltaShim, "/usr/local/bin/openclaw", "status"],
      env: { PATH: "/home/alice/.volta/bin:/usr/bin:/bin" },
      execPath: voltaShim,
    },
    {
      command: "node",
      argv: [...warningPrefix, "/usr/local/bin/openclaw", "status"],
      detachForProcessTree: true,
    },
  ],
] satisfies [string, Parameters<typeof buildPlan>[0], object][])("%s", (_name, params, expected) =>
  expect(requirePlan(params)).toMatchObject(expected),
);

it.each([
  [
    "interactive macOS retains system CA loading",
    {
      args: ["tui"],
      env: { NODE_USE_SYSTEM_CA: "1" },
      platform: "darwin",
    },
  ],
  [
    "satisfied respawn guards prevent another respawn",
    {
      env: { [caReady]: "1", [optionsReady]: "1" },
      execArgv: [warningFlag],
      autoNodeExtraCaCerts: systemCa,
    },
  ],
  [
    "Windows accepts underscore stack-size spelling",
    {
      argv: ["node", windowsScript, "dashboard"],
      execArgv: ["--stack_size=16384"],
      autoNodeExtraCaCerts: systemCa,
      platform: "win32",
    },
  ],
] satisfies [string, Parameters<typeof buildPlan>[0]][])("%s", (_name, params) => {
  expect(buildPlan(params)).toBeNull();
});

it.each([
  ["injects a discovered CA for whitespace", "linux", " ", "/etc/ca.pem", "/etc/ca.pem", "1"],
  ["drops whitespace without discovery", "linux", " ", undefined, undefined, undefined],
  ["drops whitespace on Windows", "win32", " ", undefined, undefined, undefined],
] as const)("%s", (_label, platform, inherited, discovered, expected, expectedReady) => {
  const respawnPlan = requirePlan({
    env: { NODE_EXTRA_CA_CERTS: inherited },
    autoNodeExtraCaCerts: discovered,
    platform,
  });

  expect([respawnPlan.env.NODE_EXTRA_CA_CERTS, respawnPlan.env[caReady]]).toEqual([
    expected,
    expectedReady,
  ]);
});
function mockChild() {
  const child = new EventEmitter() as ChildProcess;
  const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
  const detach = vi.fn();
  vi.mocked(attachChildProcessBridge).mockReturnValue({ detach });
  return { child, spawn, detach };
}
it("spawns the standalone plan without adding runtime flags", async () => {
  vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
  const plan = requirePlan({
    argv: [process.execPath, "/app/runtime/openclaw.mjs", "doctor"],
    platform: "darwin",
  });
  const { child, spawn } = mockChild();
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
});

it("records status after the respawn child closes", async () => {
  process.exitCode = undefined;
  const { child, spawn, detach } = mockChild();
  const writeError = vi.fn();

  const plan = {
    command: "/usr/bin/node",
    argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "/repo/openclaw/dist/entry.js", "status"],
    env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
    detachForProcessTree: true,
  };
  const completion = runCliRespawnPlan(plan, writeError);

  expect(spawn).toHaveBeenCalledWith(plan.command, plan.argv, {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: plan.env,
    detached: process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
    windowsHide: !(process.stdin.isTTY || process.stdout.isTTY),
  });
  expect(vi.mocked(attachChildProcessBridge).mock.calls[0]).toEqual([child, expect.any(Function)]);

  child.emit("exit", 7, null);
  expect(process.exitCode).toBeUndefined();
  child.emit("close", 7, null);
  await completion;
  expect(process.exitCode).toBe(7);
  expect(detach).toHaveBeenCalledOnce();
  expect(writeError).not.toHaveBeenCalled();
});
