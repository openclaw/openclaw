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

const caReady = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";

type PlanOptions = NonNullable<Parameters<typeof buildCliRespawnPlan>[0]> & { args?: string[] };
function buildPlan({ args = ["status"], autoNodeExtraCaCerts = "", ...params }: PlanOptions) {
  return buildCliRespawnPlan({
    argv: ["node", "openclaw", ...args],
    env: {},
    execArgv: [],
    platform: "linux",
    autoNodeExtraCaCerts,
    ...params,
  });
}

function requirePlan(params: Parameters<typeof buildPlan>[0]) {
  return expectDefined(buildPlan(params), "Expected CLI respawn plan");
}

const caPrefix = ["--import", CLI_PARENT_BOUND_PRELOAD];
const systemCa = "/etc/ssl/certs/ca-certificates.crt";
const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
const windowsScript =
  "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
const windowsTail = [windowsScript, "node.exe", "status"];
const voltaShim = "/home/alice/.volta/bin/volta-shim";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode ?? 0;
  vi.restoreAllMocks();
  vi.mocked(attachChildProcessBridge).mockReset();
  vi.unstubAllGlobals();
});

it.each([
  ["agent", "--local", "--message", "hi"],
  ["status"],
  ["infer", "model", "run", "--local", "--prompt-stdin"],
])("runs %j in process unless Node must reload its trust store", (...args) => {
  for (const platform of ["linux", "darwin"] as const) {
    expect(buildPlan({ args, platform, autoNodeExtraCaCerts: "" })).toBeNull();
  }
  const withCa = requirePlan({ args, autoNodeExtraCaCerts: systemCa });
  expect(withCa.env.NODE_EXTRA_CA_CERTS).toBe(systemCa);
  expect(withCa.argv).toEqual(["--import", CLI_PARENT_BOUND_PRELOAD, "openclaw", ...args]);
});

it.each(["linux", "win32"] as const)(
  "leaves foreground Gmail shutdown with its lifecycle owner on %s",
  (platform) => {
    const plan = (args: string[]) => buildPlan({ args, platform, autoNodeExtraCaCerts: systemCa });
    for (const args of [
      ["webhooks", "gmail", "run", "--account", "fixture@example.com"],
      ["--profile", "fixture", "webhooks", "gmail", "run"],
    ]) {
      expect(plan(args)).toBeNull();
    }
    expect(plan(["webhooks", "gmail", "setup"])).not.toBeNull();
  },
);

it.each([
  [
    "bare-root startup stays attached to the terminal",
    { args: [], autoNodeExtraCaCerts: systemCa },
    { argv: [...caPrefix, "openclaw"], detachForProcessTree: false },
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
      autoNodeExtraCaCerts: systemCa,
    },
    {
      command: "node",
      argv: [...caPrefix, "/usr/local/bin/openclaw", "status"],
      detachForProcessTree: true,
    },
  ],
] satisfies [string, Parameters<typeof buildPlan>[0], object][])("%s", (_name, params, expected) =>
  expect(requirePlan(params)).toMatchObject(expected),
);

it.each([
  [
    "macOS system CA loading needs no respawn",
    {
      args: ["cron", "list", "--json"],
      env: { NODE_USE_SYSTEM_CA: "1" },
      platform: "darwin",
    },
  ],
  [
    "explicit NODE_EXTRA_CA_CERTS needs no respawn",
    { env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" }, autoNodeExtraCaCerts: systemCa },
  ],
  [
    "satisfied respawn guard prevents another respawn",
    { env: { [caReady]: "1" }, autoNodeExtraCaCerts: systemCa },
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
    autoNodeExtraCaCerts: systemCa,
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
  process.exitCode = 0;
  const { child, spawn, detach } = mockChild();
  const writeError = vi.fn();

  const plan = {
    command: "/usr/bin/node",
    argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "/repo/openclaw/dist/entry.js", "status"],
    env: { [caReady]: "1" },
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
  expect(process.exitCode).toBe(0);
  child.emit("close", 7, null);
  await completion;
  expect(process.exitCode).toBe(7);
  expect(detach).toHaveBeenCalledOnce();
  expect(writeError).not.toHaveBeenCalled();
});
