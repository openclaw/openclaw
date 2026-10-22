import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:module";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../cli-parent-lifetime.mjs";
import { awaitGateBeforeSettlement } from "../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./daemon/windows-task-supervisor-contract.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { createDeferredCore } from "./shared/deferred.js";
import { withMockedPlatform } from "./test-utils/vitest-spies.js";

type Spawn = (...args: Parameters<typeof import("node:child_process").spawn>) => ChildProcess;

const { enableCompileCache, getCompileCacheDir, spawn, attachChildProcessBridge } = vi.hoisted(
  () => ({
    enableCompileCache: vi.fn<typeof import("node:module").enableCompileCache>(),
    getCompileCacheDir: vi.fn<() => string | undefined>(),
    spawn: vi.fn<Spawn>(),
    attachChildProcessBridge:
      vi.fn<typeof import("./process/child-process-bridge.js").attachChildProcessBridge>(),
  }),
);

// Node's enabled cache survives subsequent calls in the same instance. Observe the
// API boundary without enabling a real cache in the shared Vitest worker.
vi.mock("node:module", async (importOriginal) => {
  const { mockNodeBuiltinModule } = await import("./plugin-sdk/test-helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(() => importOriginal<typeof import("node:module")>(), {
    enableCompileCache,
    getCompileCacheDir,
  });
});
vi.mock("node:child_process", async (importOriginal) => {
  const { mockNodeBuiltinModule } = await import("./plugin-sdk/test-helpers/node-builtin-mocks.js");
  // The fixture covers the three-argument spawn call used with inherited stdio.
  return mockNodeBuiltinModule<{ spawn: Spawn }>(
    () => importOriginal<typeof import("node:child_process")>(),
    { spawn },
    { mirrorToDefault: true },
  );
});
vi.mock("./process/child-process-bridge.js", () => ({ attachChildProcessBridge }));

import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded as respawnCompileCache,
} from "./entry.compile-cache.js";
import { resolveNodeCompileCacheEnv } from "./infra/node-compile-cache-env.js";

let child: ChildProcess;
let spawned: ReturnType<typeof createDeferredCore<void>>;
let previousExitCode: typeof process.exitCode;
let detach: ReturnType<typeof vi.fn>;
const pending: Promise<unknown>[] = [];
beforeEach(() => {
  previousExitCode = process.exitCode;
  child = new EventEmitter() as ChildProcess;
  spawned = createDeferredCore();
  detach = vi.fn();
  attachChildProcessBridge.mockReset().mockReturnValue({ detach });
  spawn.mockReset().mockImplementation(() => {
    spawned.resolve();
    return child;
  });
});
afterEach(async () => {
  child.emit("close", 0, null);
  await Promise.allSettled(pending.splice(0));
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("entry compile cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let entryFile: string;
  let argv: string[];
  let writeStderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    root = tempDirs.make("openclaw-compile-cache-");
    entryFile = path.join(root, "dist", "entry.js");
    argv = [process.execPath, entryFile, "status", "--json"];
    vi.stubEnv("NODE_COMPILE_CACHE", path.join(root, ".node-cache"));
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", undefined);
    vi.stubEnv("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", undefined);
    enableCompileCache.mockReset().mockReturnValue({
      status: constants.compileCacheStatus.ALREADY_ENABLED,
      directory: path.join(root, ".node-cache"),
    });
    getCompileCacheDir.mockReset();
    vi.spyOn(process, "argv", "get").mockImplementation(() => argv);
    vi.spyOn(process, "execArgv", "get").mockReturnValue(["--no-warnings"]);
    // A nondefault status proves settlement has not published either success or failure.
    process.exitCode = 17;
    writeStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  function respawn(options: Omit<Parameters<typeof respawnCompileCache>[0], "currentFile"> = {}) {
    const completion = respawnCompileCache({ currentFile: entryFile, ...options });
    pending.push(completion);
    return completion;
  }

  async function startRespawn() {
    const completion = respawn();
    await awaitGateBeforeSettlement(
      spawned.promise,
      completion,
      "compile-cache respawn did not start",
    );
    return { completion };
  }

  function useSourceEntry() {
    // The respawn policy classifies the entry extension; it never reads this file.
    entryFile = path.join(root, "src", "entry.ts");
    argv[1] = entryFile;
  }

  function enableCache(env: NodeJS.ProcessEnv = {}) {
    enableOpenClawCompileCache({ currentFile: entryFile, env, installRoot: root });
  }

  it("resolves install roots from source and dist entry paths", () => {
    expect(resolveEntryInstallRoot("/repo/openclaw/src/entry.ts")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/repo/openclaw/dist/entry.js")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/pkg/openclaw/entry.js")).toBe("/pkg/openclaw");
  });

  it("activates compiled worker cache unless explicitly disabled", () => {
    argv = [process.execPath, entryFile, "gateway", "run"];
    enableCache();
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
    enableCache({ NODE_DISABLE_COMPILE_CACHE: "1" });
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
    enableOpenClawCompileCache({ currentFile: entryFile, installRoot: root });
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gateway", WINDOWS_TASK_SUPERVISOR_FLAG],
    ["gateway", "run", `${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=65536`],
  ])("keeps worker caching for Windows service arguments: %j", (...args) => {
    argv = [process.execPath, entryFile, ...args];
    enableCache();
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
  });

  it("keeps compiled one-shot commands free of automatic exit-time cache work", () => {
    argv = [process.execPath, entryFile, "config", "set", "gateway.mode", "local"];
    enableCache();
    expect(enableCompileCache).not.toHaveBeenCalled();
    enableCache({ NODE_COMPILE_CACHE: path.join(root, ".requested-cache") });
    expect(enableCompileCache).toHaveBeenCalledOnce();
  });

  it("skips cache activation with a warning when Windows TEMP makes the path too long", () => {
    argv = [process.execPath, entryFile, "gateway", "run"];
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(root, "x".repeat(200)));
    withMockedPlatform("win32", () => {
      enableCache();
    });
    expect(enableCompileCache).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Compile cache disabled: Windows cache path exceeds 200 characters"),
    );
  });

  it.each([200, 201])("bounds Windows child cache paths at 200 characters: %s", (length) => {
    const directory = path.join(root, "x".repeat(length - root.length - 1));
    const env = { NODE_COMPILE_CACHE: directory, KEEP: "unchanged" };
    withMockedPlatform("win32", () => {
      const childEnv = resolveNodeCompileCacheEnv(env);
      if (length === 200) {
        expect(childEnv).toBe(env);
        expect(writeStderr).not.toHaveBeenCalled();
      } else {
        expect(childEnv).toEqual({ NODE_DISABLE_COMPILE_CACHE: "1", KEEP: "unchanged" });
        expect(writeStderr).toHaveBeenCalledOnce();
      }
    });
    expect(env.NODE_COMPILE_CACHE).toBe(directory);
  });

  it.each([
    { mode: "inherited", cli: ["status", "--json"] },
    { mode: "active", cli: ["status", "--json"] },
    { mode: "standalone", cli: ["status", "--json"] },
    { mode: "interactive", cli: [] },
    { mode: "interactive", cli: ["tui"] },
  ])("respawns $mode without caching: $cli", async ({ mode, cli }) => {
    useSourceEntry();
    argv = [process.execPath, entryFile, ...cli];
    if (mode === "active") {
      vi.stubEnv("NODE_COMPILE_CACHE", undefined);
      getCompileCacheDir.mockReturnValue(path.join(root, ".active-cache"));
    }
    const standalone = mode === "standalone";
    if (standalone) {
      vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${root}/`).href);
    }
    const { completion } = await startRespawn();
    expect(spawn).toHaveBeenCalledOnce();
    const options = expectDefined(spawn.mock.calls[0], "respawn call")[2];
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      standalone ? cli : ["--import", CLI_PARENT_BOUND_PRELOAD, "--no-warnings", entryFile, ...cli],
      expect.objectContaining({
        env: expect.objectContaining({
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: "1",
        }),
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached:
          mode !== "interactive" &&
          process.platform !== "win32" &&
          !(process.stdin.isTTY || process.stdout.isTTY),
      }),
    );
    expect(options?.env?.NODE_COMPILE_CACHE).toBeUndefined();
    if (standalone) {
      expect(options?.env?.OPENCLAW_CLI_RESPAWN_PARENT).toBe(String(process.pid));
    }
    expect(attachChildProcessBridge).toHaveBeenCalledWith(child, expect.any(Function));
    child.emit("exit", 0, null);
    expect(process.exitCode).toBe(17);
    child.emit("close", 0, null);
    await expect(completion).resolves.toBe(true);
    expect(process.exitCode).toBe(0);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  const commands = {
    hooks: ["hooks", "relay", "--relay-id", "relay-1"],
    gmail: ["webhooks", "--profile", "fixture", "gmail", "run"],
    gateway: ["--profile=fixture", "gateway", "run"],
    status: ["status", "--json"],
  };
  it.each([
    ["hooks", "linux", "source", false],
    ["hooks", "win32", "source", true],
    ["gmail", "linux", "source", false],
    ["gmail", "win32", "source", false],
    ["gateway", "linux", "source", false],
    ["status", "linux", "package", false],
    ["status", "linux", "respawned", false],
  ] as const)(
    "respects %s/%s respawn policy for %s",
    async (command, platform, install, respawns) => {
      if (install !== "package") {
        useSourceEntry();
      }
      if (install === "respawned") {
        vi.stubEnv("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", "1");
      }
      argv = [process.execPath, entryFile, ...commands[command]];
      await withMockedPlatform(platform, async () => {
        const completion = respawn();
        if (respawns) {
          await spawned.promise;
          child.emit("close", 0, null);
        }
        await expect(completion).resolves.toBe(respawns);
        expect(spawn).toHaveBeenCalledTimes(respawns ? 1 : 0);
      });
    },
  );

  it("awaits diagnostic setup while preserving the child environment snapshot", async () => {
    useSourceEntry();
    vi.stubEnv("OPENCLAW_PROFILE", "before-diagnostics");
    const writer = createDeferredCore<(message: string) => void>();
    const writeError = vi.fn();
    const prepareWriteError = vi.fn(() => writer.promise);
    const diagnosticCompletion = respawn({ prepareWriteError });
    try {
      expect(prepareWriteError).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      vi.stubEnv("OPENCLAW_PROFILE", "after-diagnostics");
    } finally {
      writer.resolve(writeError);
      await spawned.promise;
    }
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.env?.OPENCLAW_PROFILE).toBe(
      "before-diagnostics",
    );
    child.emit("error", new Error("spawn failed"));
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Failed to respawn CLI without compile cache: Error: spawn failed"),
    );
    expect(writeStderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(17);
    child.emit("close", -2, null);
    await expect(diagnosticCompletion).resolves.toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe("entry respawn", () => {
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
      "bare root stays attached",
      { args: [], autoNodeExtraCaCerts: systemCa },
      { argv: [...warningPrefix, "openclaw"], detachForProcessTree: false },
    ],
    [
      "preserves macOS system trust",
      { args: ["cron", "list", "--json"], env: { NODE_USE_SYSTEM_CA: "1" }, platform: "darwin" },
      {
        argv: [...warningPrefix, "openclaw", "cron", "list", "--json"],
        env: { NODE_USE_SYSTEM_CA: "1" },
      },
    ],
    [
      "preserves an explicit CA",
      { env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" }, autoNodeExtraCaCerts: systemCa },
      { env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" } },
    ],
    [
      "preserves post-script node.exe",
      {
        argv: [windowsNode, windowsNode, ...windowsTail],
        execPath: windowsNode,
        platform: "win32",
      },
      { argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "--stack-size=8192", ...windowsTail] },
    ],
    [
      "uses node for Volta shims",
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
  ] satisfies [string, Parameters<typeof buildPlan>[0], object][])(
    "%s",
    (_name, params, expected) => expect(requirePlan(params)).toMatchObject(expected),
  );

  it.each([
    [
      "retains interactive system trust",
      { args: ["tui"], env: { NODE_USE_SYSTEM_CA: "1" }, platform: "darwin" },
    ],
    [
      "honors respawn guards",
      {
        env: { [caReady]: "1", [optionsReady]: "1" },
        execArgv: [warningFlag],
        autoNodeExtraCaCerts: systemCa,
      },
    ],
    [
      "accepts underscore stack_size",
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
  it("records status after the respawn child closes", async () => {
    process.exitCode = undefined;
    const writeError = vi.fn();

    const plan = {
      command: "/usr/bin/node",
      argv: ["--import", CLI_PARENT_BOUND_PRELOAD, "/repo/openclaw/dist/entry.js", "status"],
      env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
      detachForProcessTree: true,
    };
    const completion = runCliRespawnPlan(plan, writeError);
    pending.push(completion);

    expect(spawn).toHaveBeenCalledWith(plan.command, plan.argv, {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: plan.env,
      detached: process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
      windowsHide: !(process.stdin.isTTY || process.stdout.isTTY),
    });
    expect(vi.mocked(attachChildProcessBridge).mock.calls[0]).toEqual([
      child,
      expect.any(Function),
    ]);

    child.emit("exit", 7, null);
    expect(process.exitCode).toBeUndefined();
    child.emit("close", 7, null);
    await completion;
    expect(process.exitCode).toBe(7);
    expect(detach).toHaveBeenCalledOnce();
    expect(writeError).not.toHaveBeenCalled();
  });
});
