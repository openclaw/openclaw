import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertChannelAccountRunning,
  assertCommandResourceCeiling,
  assertCreatedKitchenSinkSession,
  assertDiagnosticStabilityClean,
  assertExpectedKitchenSinkToolEntries,
  assertGatewayHealthPayload,
  assertGatewayStatusPayload,
  assertKitchenSinkImageJobInvokeResult,
  assertKitchenSinkUiDescriptors,
  assertKitchenSinkSearchInvokeResult,
  assertKitchenSinkTextInvokeResult,
  assertKitchenSinkResourcePlugins,
  assertKitchenSinkResourceShutdown,
  assertOperatorRpcDenied,
  assertResourceCeiling,
  assertTtsProviderCoverage,
  cleanupKitchenSinkEnv,
  configureKitchenSink,
  createGatewayReadyLogScanner,
  createRpcCliRunOptions,
  extractPluginCommandNames,
  fetchJson,
  findErrorLogFindings,
  findDistCallGatewayModuleFiles,
  hasChildExited,
  MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS,
  listKitchenSinkAuthorizationRpcProbeNames,
  makeEnv,
  kitchenSinkResourceEnv,
  parseJsonOutput,
  parseGatewayCliRequestFailure,
  readPositiveInt,
  readPositiveTimerMs,
  resolveKitchenSinkRpcConfig,
  resolveKitchenSinkRpcPort,
  runCommand,
  runKitchenSinkResourceToolWorkload,
  sampleProcess,
  sampleWindowsProcessByPort,
  shouldPrintHelp,
  signalGateway,
  signalProcessGroup,
  stopGateway,
  summarizeProcessSamples,
  unwrapRpcPayload,
  usesBuiltOpenClawEntry,
  validateCliArgs,
  waitForGatewayReady,
} from "../../scripts/e2e/kitchen-sink-rpc-walk.mts";
import {
  measureResourceOperations,
  type KitchenSinkResourcePhase,
} from "../../scripts/e2e/lib/kitchen-sink-resources.mts";
import {
  resolveWindowsPowerShellPath,
  resolveWindowsSystem32Path,
  resolveWindowsTaskkillPath,
} from "../../scripts/lib/windows-taskkill.mjs";
import { formatGatewayClientRequestErrorJson } from "../../src/gateway/call.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { cleanupTempDirs, makeTempDir, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

it("resource proof requires clean joined Gateway exit, not forced termination", () => {
  const clean = { exited: true, exitCode: 0, signal: null, signals: ["SIGTERM"] };
  expect(() => assertKitchenSinkResourceShutdown(clean)).not.toThrow();
  for (const failed of [
    { ...clean, exited: false },
    { ...clean, exitCode: 1 },
    { ...clean, signals: ["SIGTERM", "SIGKILL"] },
    { ...clean, exitCode: null, signal: "SIGKILL", signals: ["SIGTERM", "SIGKILL"] },
  ]) {
    expect(() => assertKitchenSinkResourceShutdown(failed)).toThrow("did not exit cleanly");
  }
});

it.each(["valid", "wrong session", "wrong tool"])(
  "measures the actual session and tool RPC callbacks: %s",
  async (response) => {
    const phases: KitchenSinkResourcePhase[] = [];
    const events: string[] = [];
    let step = 0;
    const sample = async () => {
      events.push("sample");
      step++;
      return {
        pid: 123,
        atMonotonicMicros: step * 1000,
        process: { user: step * 100, system: step * 10 },
        mainThread: { user: step * 50, system: step * 5 },
        cpuEnvironment: { availableParallelism: 2, affinity: "0-1" },
        memory: { rss: 100, heapTotal: 100, heapUsed: 100, external: 0, arrayBuffers: 0 },
        activeResources: {},
        runtime: { node: "26.0.0", platform: "linux", arch: "x64" },
      };
    };
    const rpc = vi.fn(async (method: string, _params: unknown) => {
      events.push(method);
      return method === "sessions.create"
        ? {
            ok: true,
            key: response === "wrong session" ? "wrong" : "agent:main:kitchen-sink-rpc",
            sessionId: "fixture-session",
          }
        : {
            ok: true,
            source: "plugin",
            output: {
              route: "tool:kitchen_sink_text",
              text: response === "wrong tool" ? "wrong" : "Kitchen Sink fixture",
            },
          };
    });
    const measure: Parameters<typeof runKitchenSinkResourceToolWorkload>[0]["measure"] = async (
      name,
      count,
      run,
      options,
    ) => {
      const phase = await measureResourceOperations({ name, count, run, sample, ...options });
      phases.push(phase);
      if (phase.status === "failed") {
        throw new Error(phase.error);
      }
      return phase;
    };
    const result = runKitchenSinkResourceToolWorkload({ rpc, measure }, 20);
    if (response !== "valid") {
      await expect(result).rejects.toThrow(response === "wrong session" ? "session" : "fixture");
      expect(phases.at(-1)).toMatchObject({
        status: "failed",
        operations: { attempted: 1, completed: 0, failed: 1 },
      });
      expect(rpc).toHaveBeenCalledTimes(response === "wrong session" ? 1 : 2);
      return;
    }
    await result;
    expect(rpc.mock.calls).toEqual([
      [
        "sessions.create",
        { key: "agent:main:kitchen-sink-rpc", agentId: "main", label: "kitchen-sink-resources" },
      ],
      ...Array.from({ length: 20 }, (_, index) => [
        "tools.invoke",
        {
          name: "kitchen_sink_text",
          args: { prompt: "explain kitchen sink resource profiling" },
          sessionKey: "agent:main:kitchen-sink-rpc",
          agentId: "main",
          idempotencyKey: `kitchen-sink-resources-${index}`,
        },
      ]),
    ]);
    expect(events).toEqual([
      "sample",
      "sessions.create",
      "sample",
      "sample",
      "tools.invoke",
      "sample",
      ...Array.from({ length: 19 }, () => "tools.invoke"),
      "sample",
    ]);
    expect(phases).toMatchObject([
      {
        name: "session-create",
        status: "exercised",
        operations: { attempted: 1, completed: 1, failed: 0 },
      },
      {
        name: "plugin-tool",
        status: "exercised",
        operations: { attempted: 20, completed: 20, failed: 0 },
        breakdown: [
          { name: "plugin-tool-first", operations: { completed: 1 } },
          { name: "plugin-tool-warm", operations: { completed: 19 } },
        ],
      },
    ]);
  },
);

const posixIt = process.platform === "win32" ? it.skip : it;
const realDelay = delay;
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

// The parent writes readiness before sending a receipt, so process settlement
// can consult the durable record if the independent receipt pipe arrives late.
function fixtureReadyBeforeSettlement(readyPath: string, operation: PromiseLike<unknown>) {
  return Promise.race([
    receipts.waitFor(readyPath, "ready"),
    Promise.resolve(operation).then(
      () => {
        if (!existsSync(readyPath)) {
          throw new Error("timed out waiting for condition");
        }
      },
      (error: unknown) => {
        if (!existsSync(readyPath)) {
          throw error;
        }
      },
    ),
  ]);
}

it("admits resource comparison explicitly without inheriting developer credentials", () => {
  expect(validateCliArgs([])).toBeUndefined();
  expect(validateCliArgs(["--resource-profile", "report.json"])).toBe(path.resolve("report.json"));
  expect(() => validateCliArgs(["--resource-profile"])).toThrow("requires one report path");
  expect(() => validateCliArgs(["--resource-profile", "a", "--resource-profile", "b"])).toThrow(
    "requires one report path",
  );
  const env = kitchenSinkResourceEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "test-only",
    NODE_OPTIONS: "--require=developer-hook",
    HTTPS_PROXY: "http://example.invalid",
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.HTTPS_PROXY).toBeUndefined();
  expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
});

it("rejects an active-plugin contaminated baseline and missing or failed conformance activation", () => {
  const fixture = { id: "openclaw-kitchen-sink-fixture", runtime: { state: "active" } };
  expect(assertKitchenSinkResourcePlugins({ plugins: [] }, false)).toEqual([]);
  expect(assertKitchenSinkResourcePlugins({ plugins: [fixture] }, true)).toEqual([fixture.id]);
  expect(() =>
    assertKitchenSinkResourcePlugins(
      { plugins: [fixture, { id: "memory-core", runtime: { state: "active" } }] },
      true,
    ),
  ).toThrow("Unexpected active plugins");
  expect(() => assertKitchenSinkResourcePlugins({ plugins: [fixture] }, false)).toThrow(
    "Unexpected active plugins",
  );
  expect(() => assertKitchenSinkResourcePlugins({ plugins: [] }, true)).toThrow(
    "Unexpected active plugins",
  );
  expect(() =>
    assertKitchenSinkResourcePlugins(
      { plugins: [{ ...fixture, runtime: { state: "service-failed" } }] },
      true,
    ),
  ).toThrow("Unexpected active plugins");
});

type RunTaskkill = NonNullable<
  NonNullable<Parameters<typeof signalProcessGroup>[2]>["runTaskkill"]
>;

function invokeWindowsTreeSignal(
  owner: "command" | "gateway",
  signal: NodeJS.Signals,
  runTaskkill: RunTaskkill,
) {
  const child = { kill: vi.fn(), pid: 12345 };
  const killProcess = vi.fn();
  const result =
    owner === "gateway"
      ? signalGateway(child, signal, killProcess, { platform: "win32", runTaskkill })
      : signalProcessGroup(child, signal, { platform: "win32", runTaskkill });
  expect(killProcess).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  return result;
}

function expectTaskkillCall(runTaskkill: RunTaskkill, call: number, force: boolean) {
  expect(runTaskkill).toHaveBeenNthCalledWith(
    call,
    resolveWindowsTaskkillPath(),
    ["/PID", "12345", "/T", ...(force ? ["/F"] : [])],
    { stdio: "ignore" },
  );
}

const commandResult = (stdout: string) => ({ stderr: "", stdout });

function samplePosixSnapshot(
  stdout: string,
  options: { commandLineNeedles?: string[]; platform?: NodeJS.Platform; pid?: number } = {},
) {
  return sampleProcess(options.pid ?? 4321, {
    platform: options.platform ?? "linux",
    posixCommandLineNeedles: options.commandLineNeedles,
    runCommand: async (command: string, args: string[]) => {
      expect(command).toBe("ps");
      expect(args).toEqual(["-ww", "-axo", "pid=,ppid=,rss=,pcpu=,command="]);
      return commandResult(stdout);
    },
  });
}

function createWindowsPortSampleRunner(options: {
  calls?: string[];
  extraNetstatRows?: string[];
  powershell: Error | string;
  tasklist?: string;
}) {
  return async (command: string) => {
    options.calls?.push(command);
    if (command === resolveWindowsSystem32Path("netstat.exe")) {
      return commandResult(
        [
          "  Proto  Local Address          Foreign Address        State           PID",
          ...(options.extraNetstatRows ?? []),
          "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
        ].join("\r\n"),
      );
    }
    if (command === resolveWindowsPowerShellPath()) {
      if (options.powershell instanceof Error) {
        throw options.powershell;
      }
      return commandResult(options.powershell);
    }
    if (command === resolveWindowsSystem32Path("tasklist.exe") && options.tasklist) {
      return commandResult(options.tasklist);
    }
    throw new Error(`unexpected command ${command}`);
  };
}

async function sampleWindowsSnapshot(stdout: string, commandLineNeedles?: string[]) {
  const calls: Array<{ args: string[]; command: string }> = [];
  const sample = await sampleProcess(1234, {
    platform: "win32",
    runCommand: async (command: string, args: string[]) => {
      calls.push({ args, command });
      return commandResult(stdout);
    },
    windowsCommandLineNeedles: commandLineNeedles,
  });
  return { calls, sample };
}

let processFixtureCleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    // Vitest runs afterEach before onTestFinished, including after a timeout.
    // Join fake-time process cleanup before restoring the clock it still owns.
    await processFixtureCleanup?.();
  } finally {
    processFixtureCleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

function captureSyncError(action: () => void): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected action to throw");
}

describe("kitchen-sink RPC isolated state", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.for([
    { runtime: "Node", entry: "entry.mjs", files: ["entry.mjs"], selected: "entry.mjs" },
    {
      runtime: "Bun",
      entry: "entry.mjs",
      files: ["entry.mjs", "dist/index.mjs"],
      selected: "entry.mjs",
    },
    {
      runtime: "Bun",
      entry: "",
      files: ["dist/index.mjs", "dist/index.js"],
      selected: "dist/index.mjs",
    },
    { runtime: "Bun", entry: "", files: ["dist/index.js"], selected: "dist/index.js" },
    { runtime: "Node", entry: "missing.mjs", files: ["dist/index.mjs"], selected: null },
  ])("preserves $runtime entry selection for $entry with $files", async (row, context) => {
    let executable = row.runtime === "Node" ? resolveTestNodeExecPath() : process.execPath;
    if (row.runtime === "Bun") {
      try {
        executable = (await runCommand("bun", ["-p", "process.execPath"])).stdout.trim();
      } catch (error) {
        // Ordinary Node CI does not install Bun; dedicated Bun proof must run every row.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          context.skip("Bun is not installed; Bun runtime qualification is required separately");
        }
        throw error;
      }
    }
    const root = tempDirs.make("openclaw-kitchen-rpc-runtime-");
    // Do not inherit repository aliases when the temp parent is inside the checkout.
    writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
    const receiptPath = path.join(root, "entry.json");
    const fixture = `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
  execPath: process.execPath, bun: process.versions.bun, argv: process.argv, pid: process.pid
}));
process.exit(17);
`;
    for (const file of row.files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), fixture);
    }
    const preload = new URL("../../scripts/tsx.mjs", import.meta.url).href;
    const walker = fileURLToPath(
      new URL("../../scripts/e2e/kitchen-sink-rpc-walk.mts", import.meta.url),
    );
    await expect(
      runCommand(executable, [...(row.runtime === "Node" ? ["--import", preload] : []), walker], {
        cwd: root,
        env: { ...process.env, OPENCLAW_ENTRY: row.entry, TMPDIR: root, TEMP: root, TMP: root },
      }),
    ).rejects.toMatchObject({
      status: 1,
      stderr: expect.stringContaining(row.selected ? "failed with 17" : row.entry),
    });
    if (!row.selected) {
      expect(existsSync(receiptPath)).toBe(false);
      return;
    }
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(fs.realpathSync(receipt.execPath)).toBe(fs.realpathSync(executable));
    expect(receipt.bun).toEqual(row.runtime === "Bun" ? expect.any(String) : undefined);
    expect(receipt.argv.slice(1)).toEqual([
      path.join(root, row.selected),
      "plugins",
      "install",
      "--help",
    ]);
    expect(Number.isSafeInteger(receipt.pid) && receipt.pid > 0).toBe(true);
    expect(isProcessAlive(receipt.pid)).toBe(false);
  });

  it("prints help before malformed guardrails without creating temp state", async () => {
    const result = await runCommand(
      process.execPath,
      ["--import", "tsx", "scripts/e2e/kitchen-sink-rpc-walk.mts", "--help"],
      { env: { ...process.env, OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB: "1e3" } },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/e2e/kitchen-sink-rpc-walk.mts",
    );
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_NPM_SPEC");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_PORT");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS");
    expect(result.stdout).not.toContain("Kitchen Sink RPC walk using");
    expect(result.stdout).not.toContain("temp root preserved");
  });

  it("detects short and long help flags", () => {
    expect(shouldPrintHelp(["--help"])).toBe(true);
    expect(shouldPrintHelp(["-h"])).toBe(true);
    expect(shouldPrintHelp([])).toBe(false);
  });

  it("rejects unknown CLI args before creating temp state", async () => {
    expect(() => validateCliArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const error = await runCommand(process.execPath, [
      "--import",
      "tsx",
      "scripts/e2e/kitchen-sink-rpc-walk.mts",
      "--wat",
    ]).then(
      () => undefined,
      (caught: unknown) => caught as Error & { stderr?: string; stdout?: string },
    );

    expect(error).toBeDefined();
    expect(error?.stdout).toBe("");
    expect(error?.stderr?.trim()).toBe("Unknown argument: --wat");
    expect(error?.stderr).not.toContain("temp root preserved");
  });

  it("rejects loose numeric env values before they bypass runtime guardrails", () => {
    expect(readPositiveInt(undefined, 60_000)).toBe(60_000);
    expect(readPositiveInt("", 60_000)).toBe(60_000);
    expect(readPositiveInt("1000", 60_000)).toBe(1000);
    expect(readPositiveInt(" 1000 ", 60_000)).toBe(1000);
    expect(() => readPositiveInt("1e3", 60_000, "OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB")).toThrow(
      'OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB must be a positive integer. Got: "1e3"',
    );
    expect(() => readPositiveInt("1000ms", 60_000, "OPENCLAW_KITCHEN_SINK_RPC_READY_MS")).toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_READY_MS must be a positive integer. Got: "1000ms"',
    );
    expect(() => readPositiveInt("0", 60_000, "OPENCLAW_KITCHEN_SINK_RPC_PORT")).toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_PORT must be a positive integer. Got: "0"',
    );
  });

  it("clamps timer env values before they reach Node timers", () => {
    const oversizedTimerMs = String(Number.MAX_SAFE_INTEGER);

    expect(readPositiveTimerMs(oversizedTimerMs, 60_000)).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);

    const config = resolveKitchenSinkRpcConfig({
      OPENCLAW_KITCHEN_SINK_RPC_CALL_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_READY_MS: oversizedTimerMs,
    });

    expect(config.rpcTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.commandTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.fetchTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.installTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.readyTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(
      createRpcCliRunOptions("kitchen_sink_text", {
        env: {
          OPENCLAW_KITCHEN_SINK_RPC_CALL_MS: String(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS),
        },
      }).timeoutMs,
    ).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
  });

  it("uses an explicit RPC port or asks the OS for an available fallback", async () => {
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "19080" }),
    ).resolves.toBe(19080);
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "65535" }),
    ).resolves.toBe(65535);
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "65536" }),
    ).rejects.toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_PORT must be a TCP port from 1 to 65535. Got: "65536"',
    );
    await expect(
      resolveKitchenSinkRpcPort({}, { findAvailablePort: async () => 45678 }),
    ).resolves.toBe(45678);
  });

  it("cleans up the generated temporary home tree", async () => {
    const { root, env } = makeEnv();

    expect(root).toContain("openclaw-kitchen-sink-rpc-");
    expect(env.HOME).toBe(path.join(root, "home"));
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.OPENCLAW_HOME).toBe(env.HOME);
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(env.HOME, ".openclaw"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"));
    expect(existsSync(env.OPENCLAW_STATE_DIR)).toBe(true);

    await expect(cleanupKitchenSinkEnv(root)).resolves.toBe(true);

    expect(existsSync(root)).toBe(false);
  });

  it("preserves a disabled memory slot when enabling the resource fixture", async () => {
    const { root, env } = makeEnv(kitchenSinkResourceEnv());
    try {
      writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({ plugins: { enabled: false, slots: { memory: "none" } } }),
      );
      configureKitchenSink(env, 18888);
      const config = JSON.parse(readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8"));
      expect(config.plugins).toMatchObject({
        enabled: true,
        slots: { memory: "none" },
        allow: ["openclaw-kitchen-sink-fixture"],
        entries: {
          "openclaw-kitchen-sink-fixture": {
            enabled: true,
            config: { personality: "conformance" },
          },
        },
      });
    } finally {
      await cleanupKitchenSinkEnv(root);
    }
  });

  it("can fail the walk when generated temp cleanup cannot remove the root", async () => {
    const rmSyncSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("device busy");
    });

    try {
      await expect(
        cleanupKitchenSinkEnv("/tmp/openclaw-kitchen-sink-rpc-stuck", {
          attempts: 3,
          delayMs: 1,
          throwOnFailure: true,
          warn: false,
        }),
      ).rejects.toThrow(
        "failed to remove Kitchen Sink RPC temp root: /tmp/openclaw-kitchen-sink-rpc-stuck",
      );
      expect(rmSyncSpy).toHaveBeenCalledTimes(3);
    } finally {
      rmSyncSpy.mockRestore();
    }
  });
});

describe("kitchen-sink RPC gateway teardown", () => {
  it("treats signaled gateway children as exited", () => {
    expect(hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("releases gateway handles when the process ignores teardown signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();

    await stopGateway(child, { killGraceMs: 1, teardownGraceMs: 1 });

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each(["ESRCH", "false"])(
    "treats %s gateway kill outcomes as already exited",
    async (outcome) => {
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        kill: ReturnType<typeof vi.fn>;
        signalCode: NodeJS.Signals | null;
      };
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => {
        if (outcome === "ESRCH") {
          throw Object.assign(new Error("process already exited"), { code: "ESRCH" });
        }
        return false;
      });

      await expect(
        stopGateway(child, { killGraceMs: 1, teardownGraceMs: 1 }),
      ).resolves.toBeUndefined();

      expect(child.kill).toHaveBeenCalledOnce();
    },
  );
  it.each(["gateway", "command"] as const)(
    "signals Windows %s process trees and escalates failed graceful taskkill",
    (owner) => {
      for (const gracefulStatus of [0, 1]) {
        const runTaskkill =
          gracefulStatus === 0
            ? vi.fn<RunTaskkill>(() => ({ error: undefined, status: 0 }))
            : vi
                .fn<RunTaskkill>()
                .mockReturnValueOnce({ error: undefined, status: 1 })
                .mockReturnValueOnce({ error: undefined, status: 0 });
        expect(invokeWindowsTreeSignal(owner, "SIGTERM", runTaskkill)).toBe(
          owner === "gateway" ? true : undefined,
        );
        expectTaskkillCall(runTaskkill, 1, false);
        if (gracefulStatus === 0) {
          expect(invokeWindowsTreeSignal(owner, "SIGKILL", runTaskkill)).toBe(
            owner === "gateway" ? true : undefined,
          );
        }
        expectTaskkillCall(runTaskkill, 2, true);
      }
    },
  );

  posixIt.each(["before", "during"])(
    "joins a process group when its wrapper exits %s teardown",
    async (timing) => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: timing === "before" ? 0 : null,
        kill: vi.fn(),
        pid: 12348,
        signalCode: null as NodeJS.Signals | null,
      });
      const killProcess = vi.fn((_pid: number, signal: number | string) => {
        if (timing === "during" && signal === "SIGTERM") {
          setTimeout(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          }, 0);
        }
        return true;
      });

      await stopGateway(child, {
        killGraceMs: 1,
        killProcess,
        teardownGraceMs: timing === "before" ? 1 : 100,
      });

      expect(killProcess).toHaveBeenNthCalledWith(1, -12348, 0);
      expect(killProcess).toHaveBeenNthCalledWith(2, -12348, "SIGTERM");
      expect(killProcess).toHaveBeenCalledWith(-12348, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it("fails readiness waits before polling after signaled gateway exits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-signal-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "gateway died\n");
      const fetchImpl = vi.fn(() => {
        throw new Error("fetch should not run after process exit");
      });

      await expect(
        waitForGatewayReady({ exitCode: null, signalCode: "SIGTERM" }, 9, logPath, {
          fetchImpl,
          pollDelayMs: 1,
          timeoutMs: 1,
        }),
      ).rejects.toThrow("gateway exited before ready");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts stalled readiness probes when the gateway exits mid-probe", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-exit-during-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "gateway died during readiness\n");
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null as NodeJS.Signals | null,
      });
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const reason = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("fetch aborted"));
            },
            { once: true },
          );
        });
      });
      const startedAt = Date.now();
      setTimeout(() => {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      }, 25);

      await expect(
        waitForGatewayReady(child, 9, logPath, {
          fetchImpl,
          pollDelayMs: 5_000,
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow("gateway exited before ready");

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps stalled readiness probes inside the caller deadline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-stalled-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "booting\n");
      let calls = 0;
      const startedAt = Date.now();

      await expect(
        waitForGatewayReady({ exitCode: null, signalCode: null }, 9, logPath, {
          fetchImpl: () => {
            calls += 1;
            return new Promise(() => {});
          },
          pollDelayMs: 1,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("gateway did not become ready");

      expect(calls).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires /readyz body.ready before accepting gateway readiness", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-ready-body-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "[gateway] ready\n");
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"ready":false}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{"ready":true}', { status: 200 }));

      const readiness = expect(
        waitForGatewayReady({ exitCode: null, signalCode: null }, 9, logPath, {
          fetchImpl,
          pollDelayMs: 1,
          timeoutMs: 100,
        }),
      ).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await readiness;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kitchen-sink RPC gateway readiness logs", () => {
  it.each(["append", "rotate"])("finds readiness across %s updates", (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-scan-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "booting\n".repeat(1000));
      const scanner = createGatewayReadyLogScanner(logPath, "[gateway] ready");

      expect(scanner()).toBe(false);

      if (mode === "append") {
        writeFileSync(logPath, "[gateway] rea", { flag: "a" });
        expect(scanner()).toBe(false);
        writeFileSync(logPath, "dy\n", { flag: "a" });
      } else {
        writeFileSync(logPath, "[gateway] ready\n");
      }
      expect(scanner()).toBe(true);
      expect(scanner()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "late failure",
      text: `${"ordinary line\n".repeat(2000)}0 errors\n[ERROR] late failure\n`,
      line: "[ERROR] late failure",
      lineNumber: 2002,
      truncated: false,
    },
    {
      name: "dirty zero-error line",
      text: "[ERROR] 0 errors reported but fatal state remained\n",
      line: "[ERROR] 0 errors reported but fatal state remained",
      lineNumber: 1,
      truncated: false,
    },
    {
      name: "bounded long line",
      text: `${"x".repeat(200_000)}[ERROR] giant line\n`,
      line: "[truncated]",
      lineNumber: 1,
      truncated: true,
    },
  ])("retains error findings for $name", ({ text, line, lineNumber, truncated }) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-errors-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, text);
      const findings = findErrorLogFindings(logPath);
      if (truncated) {
        expect(findings).toHaveLength(1);
        expect(findings[0]?.lineNumber).toBe(lineNumber);
        expect(findings[0]?.line).toContain(line);
        expect(findings[0]?.line.length).toBeLessThan(20_000);
      } else {
        expect(findings).toEqual([{ line, lineNumber }]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kitchen-sink RPC command output capture", () => {
  it.each([
    { exitCode: 0, stdout: "abcdef", stderr: "UVWXYZ", outputCaptureChars: 3 },
    { exitCode: 7, stdout: "request failure", stderr: "diagnostic", outputCaptureChars: undefined },
  ])(
    "preserves bounded command output for exit $exitCode",
    async ({ exitCode, stdout, stderr, outputCaptureChars }) => {
      const result = runCommand(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); ${exitCode === 0 ? "" : `process.exit(${exitCode})`}`,
        ],
        { outputCaptureChars },
      );
      if (exitCode === 0) {
        await expect(result).resolves.toEqual({
          stdout: "def",
          stderr: "XYZ",
          stdoutTruncatedChars: 3,
          stderrTruncatedChars: 3,
        });
      } else {
        await expect(result).rejects.toMatchObject({ status: 7, signal: null, stdout, stderr });
      }
    },
  );

  it("clamps oversized command timeout env values before scheduling timers", async () => {
    const previousTimeout = process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS;
    process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS = String(Number.MAX_SAFE_INTEGER);
    try {
      await expect(
        runCommand(process.execPath, [
          "--input-type=module",
          "--eval",
          "setTimeout(() => process.exit(0), 25);",
        ]),
      ).resolves.toMatchObject({ stdout: "", stderr: "" });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS;
      } else {
        process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS = previousTimeout;
      }
    }
  });

  posixIt("kills timed command process groups", async ({ signal, onTestFinished }) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-timeout-"));
    const scriptPath = path.join(root, "trap-term.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    let grandchildPid = 0;
    const grandchildScript = [
      "process.on('SIGTERM', () => {});",
      "process.send('ready');",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}

const grandchild = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(grandchildScript)},
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
grandchild.once("message", () => {
  fs.writeFileSync(process.argv[3], "ready");
  sendReceipt(process.argv[3], "ready");
});
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const runPromise = runCommand(
      process.execPath,
      [scriptPath, grandchildPidPath, grandchildReadyPath],
      {
        detached: undefined,
        timeoutKillGraceMs: 25,
        timeoutMs: 500,
      },
    );
    const runErrorPromise = runPromise.then(
      () => {
        throw new Error("expected timed command to reject");
      },
      (error: unknown) => error,
    );

    let finishing: Promise<unknown> | undefined;
    const finishCommand = () =>
      (finishing ??= (async () => {
        if (vi.isFakeTimers()) {
          await vi.runAllTimersAsync();
          vi.useRealTimers();
        }
        return runErrorPromise;
      })());
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        await finishCommand();
        if (!grandchildPid && existsSync(grandchildPidPath)) {
          grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
        }
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      })());
    processFixtureCleanup = cleanup;
    onTestFinished(cleanup);

    try {
      await withinTest(fixtureReadyBeforeSettlement(grandchildReadyPath, runPromise), signal);
      grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      const runError = await withinTest(finishCommand(), signal);
      expect(runError).toBeInstanceOf(Error);
      expect((runError as Error).message).toContain("timed out after 500ms");
      await waitForProcessExit(grandchildPid, signal);
    } finally {
      await cleanup();
    }
  });

  it.each(["sample", "missing", "error"])(
    "records required command resource proof: %s",
    async (outcome) => {
      const samples: Array<{
        aggregateRssMiB?: number;
        elapsedMs?: number;
        label?: string;
        processId?: number;
        rssMiB?: number;
      }> = [];
      const seenPids: number[] = [];

      const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 50);"], {
        requireResourceSample: outcome !== "sample",
        resourceLabel: "plugins install",
        resourceSampleIntervalMs: 1,
        resourceSamples: samples,
        sampleProcessImpl: async (pid: number) => {
          seenPids.push(pid);
          if (outcome === "error") {
            throw new Error("ps failed");
          }
          if (outcome === "missing") {
            return null;
          }
          return {
            aggregateRssMiB: 640,
            cpuPercent: 12,
            processId: pid + 1,
            rssMiB: 512,
          };
        },
      });

      if (outcome !== "sample") {
        await expect(result).rejects.toThrow(
          `plugins install RSS sample was not captured${outcome === "error" ? ": ps failed" : ""}`,
        );
        expect(samples).toEqual([]);
        return;
      }
      expect((await result).stdout).toBe("");
      expect(seenPids.length).toBeGreaterThan(0);
      expect(samples[0]).toMatchObject({
        aggregateRssMiB: 640,
        label: "plugins install",
        processId: expectDefined(seenPids[0], "sampled kitchen sink process id") + 1,
        rssMiB: 512,
      });
      expect(samples[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  );

  it("rejects command spawn failures as Error objects", async () => {
    await expect(runCommand("openclaw-definitely-missing-command", [])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("kitchen-sink RPC caller loading", () => {
  it("samples CLI-backed gateway RPC calls as command work", () => {
    const resourceSamples: unknown[] = [];

    expect(
      createRpcCliRunOptions("tools.invoke", {
        commandResourceOptions: {
          resourceSampleIntervalMs: 500,
          resourceSamples,
        },
      }),
    ).toMatchObject({
      resourceLabel: "gateway call tools.invoke",
      resourceSampleIntervalMs: 500,
      resourceSamples,
      timeoutMs: 90_000,
    });
  });

  it("loads built callGateway chunks only for dist and packaged entries", () => {
    expect(usesBuiltOpenClawEntry({ command: "node", baseArgs: ["dist/index.js"] })).toBe(true);
    expect(
      usesBuiltOpenClawEntry({ command: "node", baseArgs: ["/app/openclaw.mjs"] }, "/repo", {
        OPENCLAW_ENTRY: "/app/openclaw.mjs",
      }),
    ).toBe(true);
    expect(usesBuiltOpenClawEntry({ pnpm: true, baseArgs: ["openclaw"] })).toBe(false);
    expect(usesBuiltOpenClawEntry({ command: "node", baseArgs: ["scripts/dev.mjs"] })).toBe(false);
  });

  it("finds only built callGateway chunks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-rpc-call-chunks-"));
    try {
      mkdirSync(path.join(root, "dist"));
      writeFileSync(path.join(root, "dist", "call-Abc123.js"), "");
      writeFileSync(path.join(root, "dist", "call-Abc123.mjs"), "");
      writeFileSync(path.join(root, "dist", "call.runtime-Def456.js"), "");
      writeFileSync(path.join(root, "dist", "call.runtime-Def456.mjs"), "");
      writeFileSync(path.join(root, "dist", "index.js"), "");

      expect(findDistCallGatewayModuleFiles(root)).toEqual([
        "call-Abc123.js",
        "call-Abc123.mjs",
        "call.runtime-Def456.js",
        "call.runtime-Def456.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt(
    "kills descendants when timed commands exit cleanly after SIGTERM",
    async ({ signal, onTestFinished }) => {
      const tempDirs: string[] = [];
      const root = makeTempDir(tempDirs, "openclaw-kitchen-rpc-timeout-clean-parent-");
      const scriptPath = path.join(root, "term-zero-grandchild.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const grandchildReadyPath = path.join(root, "grandchild.ready");
      const parentPidPath = path.join(root, "parent.pid");
      let grandchildPid = 0;
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "process.send('ready');",
        "setInterval(() => {}, 1000);",
      ].join(" ");

      writeFileSync(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}

const grandchild = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(grandchildScript)},
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
grandchild.once("message", () => {
  fs.writeFileSync(process.argv[3], "ready");
  sendReceipt(process.argv[3], "ready");
});
process.on("SIGTERM", () => process.exit(0));
fs.writeFileSync(process.argv[4], String(process.pid));
fs.writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      // Advance command deadlines only after the real processes report that
      // their signal handlers are installed.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const runPromise = runCommand(
        process.execPath,
        [scriptPath, grandchildPidPath, grandchildReadyPath, parentPidPath],
        {
          timeoutKillGraceMs: 100,
          timeoutMs: 100,
        },
      );
      const runErrorPromise = runPromise.catch((error: unknown) => error);
      let finishing: Promise<unknown> | undefined;
      const finishCommand = () =>
        (finishing ??= (async () => {
          if (vi.isFakeTimers()) {
            await vi.runAllTimersAsync();
            vi.useRealTimers();
          }
          return runErrorPromise;
        })());

      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () =>
        (cleanupPromise ??= (async () => {
          try {
            // A readiness/assertion failure must still fire the deadline and kill grace.
            await finishCommand();
          } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
            if (!grandchildPid && existsSync(grandchildPidPath)) {
              grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
            }
            if (grandchildPid && isProcessAlive(grandchildPid)) {
              process.kill(grandchildPid, "SIGKILL");
            }
            cleanupTempDirs(tempDirs);
          }
        })());
      processFixtureCleanup = cleanup;
      onTestFinished(cleanup);

      try {
        await withinTest(fixtureReadyBeforeSettlement(grandchildReadyPath, runPromise), signal);
        grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
        const parentPid = Number.parseInt(readText(parentPidPath), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        await vi.advanceTimersByTimeAsync(100);
        await waitForProcessExit(parentPid, signal);
        const runError = await withinTest(finishCommand(), signal);
        expect(runError).toBeInstanceOf(Error);
        expect((runError as Error).message).toContain("timed out after 100ms");
        expect(runError).toMatchObject({ status: 0, signal: null });
        await waitForProcessExit(grandchildPid, signal);
      } finally {
        await cleanup();
      }
    },
  );

  posixIt(
    "cleans active command process groups before parent signal exit",
    async ({ signal, onTestFinished }) => {
      const tempDirs: string[] = [];
      const root = makeTempDir(tempDirs, "openclaw-kitchen-rpc-parent-signal-");
      const runnerPath = path.join(root, "runner.mjs");
      const scriptPath = path.join(root, "term-zero-grandchild.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const readyPath = path.join(root, "ready");
      let grandchildPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;
      let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        "process.send('ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      writeFileSync(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}

const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
grandchild.once("message", () => {
  fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
  sendReceipt(${JSON.stringify(readyPath)}, "ready");
});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        "utf8",
      );
      writeFileSync(
        runnerPath,
        `
import { runCommand } from ${JSON.stringify(
          resolveRuntimeWorkerUrl(toolingMtsEntrypoints.kitchenSinkRpcWalk).href,
        )};

await runCommand(process.execPath, [${JSON.stringify(scriptPath)}], {
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});
`,
        "utf8",
      );

      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () =>
        (cleanupPromise ??= (async () => {
          // Let the runner retire its detached command group even if readiness failed.
          if (runner?.pid && isProcessAlive(runner.pid)) {
            runner.kill("SIGTERM");
          }
          await closed;
          if (!grandchildPid && existsSync(grandchildPidPath)) {
            grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
          }
          if (grandchildPid && isProcessAlive(grandchildPid)) {
            process.kill(grandchildPid, "SIGKILL");
          }
          cleanupTempDirs(tempDirs);
        })());
      processFixtureCleanup = cleanup;
      onTestFinished(cleanup);

      try {
        const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_TEST_KITCHEN_SINK_PARENT_SIGNAL_KILL_GRACE_MS: "100",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        runner = child;
        closed = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
        });
        await withinTest(fixtureReadyBeforeSettlement(readyPath, closed), signal);
        grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(withinTest(closed, signal)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForProcessExit(grandchildPid, signal);
      } finally {
        await cleanup();
      }
    },
  );
});

describe("kitchen-sink RPC payload unwrapping", () => {
  it("parses the final JSON record without accepting inline diagnostic objects", () => {
    const parsed = parseJsonOutput(
      [
        'debug: ignored inline diagnostic {"ok":false,"result":{"stale":true}}',
        JSON.stringify({ ok: true, result: { current: true } }, null, 2),
        'warning: ignored trailing diagnostic {"ok":false,"result":{"stale":true}}',
      ].join("\n"),
    );
    expect(parsed).toEqual({ ok: true, result: { current: true } });
  });

  it("preserves payload precedence and rejects typed or bounded error envelopes", () => {
    for (const [payload, expected] of [
      [{ jsonrpc: "2.0", result: null }, null],
      [{ jsonrpc: "2.0", result: undefined }, undefined],
      [{ result: false, payload: { stale: true } }, false],
      [{ payload: null, data: { stale: true } }, null],
      [{ data: 0 }, 0],
      [{ error: { message: "ignored" }, payload: { ok: true } }, { ok: true }],
    ]) {
      expect(unwrapRpcPayload(payload)).toEqual(expected);
    }
    for (const { payload, metadata, messages, bounded } of [
      {
        payload: { error: { message: "session store unavailable" } },
        metadata: {},
        messages: ["gateway RPC returned error envelope", "session store unavailable"],
        bounded: false,
      },
      {
        payload: {
          ok: false,
          error: {
            type: "gateway_request_error",
            code: "INVALID_REQUEST",
            message: "unauthorized role: operator",
            details: { method: "skills.bins" },
            retryable: false,
            retryAfterMs: 250,
          },
        },
        metadata: {
          name: "GatewayClientRequestError",
          message: "unauthorized role: operator",
          gatewayCode: "INVALID_REQUEST",
          details: { method: "skills.bins" },
          retryable: false,
          retryAfterMs: 250,
        },
        messages: [],
        bounded: false,
      },
      {
        payload: {
          ok: false,
          error: {
            message: `rpc failed ${"x".repeat(4096)} DO_NOT_DUMP_RPC_MIDDLE ${"y".repeat(4096)} end`,
          },
        },
        metadata: {},
        messages: ["gateway RPC failed", "truncated"],
        bounded: true,
      },
    ]) {
      const error = captureSyncError(() => unwrapRpcPayload(payload));
      expect(error).toMatchObject(metadata);
      for (const message of messages) {
        expect(error.message).toContain(message);
      }
      if (bounded) {
        expect(error.message).not.toContain("DO_NOT_DUMP_RPC_MIDDLE");
        expect(error.message.length).toBeLessThan(1200);
      }
    }
  });
});

describe("kitchen-sink RPC command catalog assertions", () => {
  it("keeps plugin commands and deduplicates aliases", () => {
    expect(
      extractPluginCommandNames({
        commands: [
          {
            source: "core",
            name: "/kitchen-sink",
          },
          {
            source: "plugin",
            name: "/kitchen",
            nativeName: "kitchen",
            textAliases: ["/kitchen-sink", "kitchen-sink"],
          },
        ],
      }),
    ).toEqual(["kitchen", "kitchen-sink"]);
  });

  it.each(["missing", "wrong provenance", "complete"])(
    "validates %s plugin catalog coverage",
    (mode) => {
      const entries = ["kitchen_sink_text", "kitchen_sink_search", "kitchen_sink_image_job"].map(
        (id) => ({ id, source: "plugin", pluginId: "openclaw-kitchen-sink-fixture" }),
      );
      if (mode === "missing") {
        entries.splice(1);
      } else if (mode === "wrong provenance") {
        entries[1]!.source = "core";
        entries[2]!.pluginId = "other-plugin";
      }
      const validate = () =>
        assertExpectedKitchenSinkToolEntries(entries, "tools.catalog plugin tools", {
          requirePluginProvenance: true,
        });
      if (mode === "complete") {
        expect(validate()).toEqual([
          "kitchen_sink_text",
          "kitchen_sink_search",
          "kitchen_sink_image_job",
        ]);
      } else {
        expect(validate).toThrow(
          `tools.catalog plugin tools ${mode === "missing" ? "missing kitchen_sink_search, kitchen_sink_image_job" : "plugin provenance mismatch"}`,
        );
      }
    },
  );

  it("proves node-only RPC authorization boundaries", async () => {
    expect(listKitchenSinkAuthorizationRpcProbeNames()).toEqual(["skills.bins"]);
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => {
        throw Object.assign(new Error("unauthorized role: operator"), {
          gatewayCode: "INVALID_REQUEST",
        });
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () =>
        unwrapRpcPayload({
          ok: false,
          error: {
            type: "gateway_request_error",
            code: "INVALID_REQUEST",
            message: "unauthorized role: operator",
            retryable: false,
          },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => {
        throw new Error(
          "openclaw gateway call skills.bins failed with 1\nGateway call failed: unauthorized role: operator",
        );
      }),
    ).rejects.toThrow("Gateway call failed: unauthorized role: operator");
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => ({})),
    ).rejects.toThrow("skills.bins unexpectedly allowed operator access");
  });

  it("reconstructs typed request failures from gateway CLI JSON", async () => {
    const payload = formatGatewayClientRequestErrorJson(
      Object.assign(new Error("unauthorized role: operator"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { method: "skills.bins" },
        retryable: false,
        retryAfterMs: 250,
      }),
    );

    expect(
      parseGatewayCliRequestFailure({
        stdout: JSON.stringify(payload),
      }),
    ).toMatchObject({
      name: "GatewayClientRequestError",
      message: "unauthorized role: operator",
      gatewayCode: "INVALID_REQUEST",
      details: { method: "skills.bins" },
      retryable: false,
      retryAfterMs: 250,
    });
    expect(parseGatewayCliRequestFailure(new Error("plain failure"))).toBeNull();
    for (const invalidFields of [{ retryable: "no" }, { retryable: false, retryAfterMs: -1 }]) {
      expect(
        parseGatewayCliRequestFailure({
          stdout: JSON.stringify({
            ok: false,
            error: {
              type: "gateway_request_error",
              code: "INVALID_REQUEST",
              message: "unauthorized role: operator",
              ...invalidFields,
            },
          }),
        }),
      ).toBeNull();
    }
  });

  it("requires the exact Kitchen Sink channel account", () => {
    expect(() =>
      assertChannelAccountRunning({
        channelAccounts: {
          "kitchen-sink-channel": [{ accountId: "other", configured: true, running: true }],
        },
      }),
    ).toThrow("Kitchen Sink channel account local was not reported");
  });

  it("checks TTS providers on the exact response surfaces", () => {
    for (const [payload, surface] of [
      [{ providers: [{ id: "kitchen-sink-speech", configured: true }] }, "providers"],
      [{ providerStates: [{ id: "kitchen-sink-speech-provider", configured: true }] }, "status"],
    ] as const) {
      expect(() => assertTtsProviderCoverage(payload, surface)).not.toThrow();
    }
    for (const [payload, surface, message] of [
      [
        { metadata: { id: "kitchen-sink-speech" }, providers: [{ id: "other", configured: true }] },
        "providers",
        "tts.providers missing one of",
      ],
      [
        { providerStates: [{ id: "kitchen-sink-speech", configured: false }] },
        "status",
        "did not report a configured Kitchen Sink speech provider",
      ],
    ] as const) {
      expect(() => assertTtsProviderCoverage(payload, surface)).toThrow(message);
    }
  });

  it("validates structured tool fixtures and bounds failed invocation diagnostics", () => {
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const pngSha256 = createHash("sha256").update(pngBytes).digest("hex");
    const imageOutput = (mediaUrl: string, sha256: string) => ({
      ok: true,
      route: "tool:kitchen_sink_image_job",
      job: { status: "completed", route: "tool:kitchen_sink_image_job" },
      mediaUrl,
      image: {
        mimeType: "image/png",
        metadata: { assetName: "kitchen_sink_office.png", height: 1024, sha256, width: 1024 },
      },
    });
    const cases: Array<{
      validate: (payload: unknown) => void;
      output: unknown;
      error?: string;
      failed?: boolean;
    }> = [
      {
        validate: assertKitchenSinkSearchInvokeResult,
        output: { results: [{ title: "Kitchen Sink image fixture" }] },
      },
      {
        validate: assertKitchenSinkTextInvokeResult,
        output: {
          route: "tool:kitchen_sink_text",
          text: "Kitchen Sink text provider produced a deterministic reply.",
        },
      },
      {
        validate: assertKitchenSinkImageJobInvokeResult,
        output: imageOutput(`data:image/png;base64,${pngBytes.toString("base64")}`, pngSha256),
      },
      {
        validate: assertKitchenSinkTextInvokeResult,
        output: { route: "tool:kitchen_sink_search" },
        error: "Kitchen Sink text tool output missed expected fixture",
      },
      {
        validate: assertKitchenSinkSearchInvokeResult,
        output: { note: "prompt mentioned Kitchen Sink image fixture" },
        error: "Kitchen Sink search tool output missed expected fixture",
      },
      {
        validate: assertKitchenSinkTextInvokeResult,
        output: { text: "Kitchen Sink prompt echoed tool:kitchen_sink_text" },
        error: "Kitchen Sink text tool output missed expected fixture",
      },
      {
        validate: assertKitchenSinkImageJobInvokeResult,
        output: imageOutput("data:image/png;base64,fixture", "not-a-real-hash"),
        error: "Kitchen Sink image job tool output missed expected fixture",
      },
      {
        validate: assertKitchenSinkSearchInvokeResult,
        output: {
          text: `prefix ${"x".repeat(4096)} DO_NOT_DUMP_TOOL_MIDDLE ${"y".repeat(4096)} suffix`,
        },
        error: "Kitchen Sink search tool invoke failed",
        failed: true,
      },
    ];
    for (const { validate, output, error, failed } of cases) {
      const invoke = () => validate({ ok: !failed, source: "plugin", output });
      if (!error) {
        expect(invoke).not.toThrow();
        continue;
      }
      const caught = captureSyncError(invoke);
      expect(caught.message).toContain(error);
      if (failed) {
        expect(caught.message).toContain("truncated");
        expect(caught.message).not.toContain("DO_NOT_DUMP_TOOL_MIDDLE");
        expect(caught.message.length).toBeLessThan(1400);
      }
    }
  });

  it("requires sessions.create to return the requested Kitchen Sink session", () => {
    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:kitchen-sink-rpc",
        sessionId: "session-1",
      }),
    ).not.toThrow();

    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:stale-session",
        sessionId: "session-1",
      }),
    ).toThrow("sessions.create did not return the requested Kitchen Sink session");
    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:kitchen-sink-rpc",
      }),
    ).toThrow("sessions.create did not return the requested Kitchen Sink session");
  });

  it.each([true, false])(
    "validates descriptor payloads with expectDescriptor=%s",
    (expectDescriptor) => {
      const options = expectDescriptor ? undefined : { expectDescriptor: false };
      expect(() =>
        assertKitchenSinkUiDescriptors(
          {
            ok: true,
            descriptors: expectDescriptor
              ? [{ pluginId: "openclaw-kitchen-sink-fixture", id: "kitchen-sink-panel" }]
              : [],
          },
          options,
        ),
      ).not.toThrow();
      expect(() => assertKitchenSinkUiDescriptors({}, options)).toThrow(
        "plugins.uiDescriptors returned invalid payload",
      );
      if (expectDescriptor) {
        expect(() => assertKitchenSinkUiDescriptors({ ok: true, descriptors: [] })).toThrow(
          "plugins.uiDescriptors did not report Kitchen Sink descriptor",
        );
      }
    },
  );
});

describe("kitchen-sink RPC diagnostics assertions", () => {
  it.each([
    {
      name: "dropped and rejected",
      payload: {
        dropped: 1,
        events: [{ type: "diagnostic.async_queue.dropped" }],
        summary: { payloadLarge: { rejected: 1, truncated: 1 } },
      },
      error: "diagnostics.stability reported instability",
    },
    {
      name: "summary-only async drops",
      payload: {
        dropped: 0,
        events: [],
        summary: { byType: { "diagnostic.async_queue.dropped": 2 } },
      },
      error: "async diagnostic drops=2",
    },
    {
      name: "lossless chunking",
      payload: {
        dropped: 0,
        events: [{ type: "payload.large", action: "chunked" }],
        summary: { payloadLarge: { rejected: 0, truncated: 0, chunked: 1 } },
      },
      error: undefined,
    },
  ])("validates $name diagnostics", ({ payload, error }) => {
    const validate = () => assertDiagnosticStabilityClean(payload);
    if (error) {
      expect(validate).toThrow(error);
    } else {
      expect(validate).not.toThrow();
    }
  });
});

describe("kitchen-sink RPC health/status assertions", () => {
  it.each([
    {
      surface: "health",
      validate: assertGatewayHealthPayload,
      valid: {
        ok: true,
        ts: Date.now(),
        durationMs: 12,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 30,
        defaultAgentId: "main",
        agents: [],
        sessions: {
          path: "/tmp/openclaw-sessions.sqlite",
          count: 0,
          recent: [],
        },
      },
      invalid: { ok: false },
    },
    {
      surface: "status",
      validate: assertGatewayStatusPayload,
      valid: {
        heartbeat: {
          defaultAgentId: "main",
          agents: [],
        },
        channelSummary: [],
        queuedSystemEvents: [],
        sessions: {
          paths: [],
          count: 0,
          defaults: {
            model: null,
            contextTokens: null,
          },
          recent: [],
          byAgent: [],
        },
      },
      invalid: { heartbeat: {} },
    },
  ])(
    "accepts complete $surface and bounds failed payload diagnostics",
    ({ surface, validate, valid, invalid }) => {
      expect(() => validate({})).toThrow(`${surface} payload missing`);
      expect(() => validate(valid)).not.toThrow();
      const oversizedValue = `start ${"x".repeat(4096)} DO_NOT_DUMP_STATUS_MIDDLE ${"y".repeat(
        4096,
      )} end`;

      const error = captureSyncError(() => validate({ ...invalid, oversizedValue }));
      expect(error.message).toContain(`${surface} payload missing`);
      expect(error.message).toContain("truncated");
      expect(error.message).not.toContain("DO_NOT_DUMP_STATUS_MIDDLE");
      expect(error.message.length).toBeLessThan(1600);
    },
  );
});

describe("kitchen-sink RPC process sampling", () => {
  it("rejects unsafe Windows System32 executable names", () => {
    expect(() => resolveWindowsSystem32Path("..\\netstat.exe")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
    expect(() => resolveWindowsSystem32Path("netstat")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
  });

  it.each([
    {
      name: "process tree",
      stdout: `${256 * 1024 * 1024} 1.5 5678 ${288 * 1024 * 1024}`,
      needles: undefined,
      expected: {
        aggregateRssMiB: 288,
        cpuPercent: null,
        cpuSeconds: 1.5,
        processId: 5678,
        rssMiB: 256,
      },
      commandFragments: ["$rootPid = 1234", "ParentProcessId"],
    },
    {
      name: "missing launcher",
      stdout: `${384 * 1024 * 1024} 2.25 6789 ${512 * 1024 * 1024}`,
      needles: ["gateway", "--port", "19080"],
      expected: {
        aggregateRssMiB: 512,
        cpuPercent: null,
        cpuSeconds: 2.25,
        processId: 6789,
        rssMiB: 384,
      },
      commandFragments: [
        "CommandLine",
        "'gateway'",
        "'19080'",
        "ProcessId -eq $PID",
        "ParentProcessId",
        "Sort-Object WorkingSet64 -Descending",
      ],
    },
    {
      name: "malformed CPU and id",
      stdout: `${256 * 1024 * 1024} 2.25oops 6789x ${512 * 1024 * 1024}oops`,
      needles: undefined,
      expected: {
        aggregateRssMiB: 256,
        cpuPercent: null,
        cpuSeconds: null,
        processId: 1234,
        rssMiB: 256,
      },
      commandFragments: [],
    },
    {
      name: "malformed RSS",
      stdout: `${256 * 1024 * 1024}oops 2.25 6789 ${512 * 1024 * 1024}`,
      needles: undefined,
      expected: null,
      commandFragments: [],
    },
  ])("samples Windows RSS for $name", async ({ stdout, needles, expected, commandFragments }) => {
    const { calls, sample } = await sampleWindowsSnapshot(stdout, needles);
    expect(sample).toEqual(expected);
    expect(calls[0]?.command).toBe(resolveWindowsPowerShellPath());
    for (const fragment of commandFragments) {
      expect(calls[0]?.args.join(" ")).toContain(fragment);
    }
  });

  it("does not fall back to a PATH-resolved powershell command on Windows", async () => {
    const commands: string[] = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string) => {
        commands.push(command);
        throw new Error("trusted powershell unavailable");
      },
    });

    expect(commands).toEqual([resolveWindowsPowerShellPath()]);
    expect(sample).toBeNull();
  });

  it("samples the Windows gateway process by listening port", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return createWindowsPortSampleRunner({
          extraNetstatRows: [
            "  TCP    127.0.0.1:196750       0.0.0.0:0              LISTENING       1111",
            "  TCP    127.0.0.1:1967         0.0.0.0:0              LISTENING       2222",
          ],
          powershell: `${384 * 1024 * 1024} 2.25 6789 ${512 * 1024 * 1024}`,
        })(command);
      },
    });

    expect(sample).toEqual({
      aggregateRssMiB: 512,
      cpuPercent: null,
      cpuSeconds: 2.25,
      processId: 6789,
      rssMiB: 384,
    });
    expect(calls).toEqual([
      { command: resolveWindowsSystem32Path("netstat.exe"), args: ["-ano", "-p", "tcp"] },
      {
        command: resolveWindowsPowerShellPath(),
        args: expect.arrayContaining(["-Command", expect.stringContaining("$rootPid = 6789")]),
      },
    ]);
  });

  it.each([
    { name: "valid RSS", tasklist: '"node.exe","6789","Console","1","262,144 K"', valid: true },
    {
      name: "malformed pid",
      tasklist: '"node.exe","9999x","Console","1","262,144 K"',
      valid: true,
    },
    {
      name: "malformed RSS",
      tasklist: '"node.exe","6789","Console","1","262x144 K"',
      valid: false,
    },
  ])("uses strict tasklist fallback for $name", async ({ tasklist, valid }) => {
    const calls: string[] = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: createWindowsPortSampleRunner({
        calls,
        powershell: new Error("powershell unavailable"),
        tasklist,
      }),
    });

    expect(sample).toEqual(
      valid
        ? {
            cpuPercent: null,
            cpuSeconds: null,
            processId: 6789,
            rssMiB: 256,
          }
        : null,
    );
    expect(calls).toEqual([
      resolveWindowsSystem32Path("netstat.exe"),
      resolveWindowsPowerShellPath(),
      resolveWindowsSystem32Path("tasklist.exe"),
    ]);
  });

  it("selects valid POSIX process trees and rejects malformed rows in the sampled tree", async () => {
    const gatewayNeedles = ["gateway", "--port", "19080"];
    const rows: Array<{
      name: string;
      lines: string[];
      options?: Parameters<typeof samplePosixSnapshot>[1];
      expected: Awaited<ReturnType<typeof samplePosixSnapshot>>;
    }> = [
      {
        name: "direct gateway with descendants",
        lines: [
          " 4321     1  262144  12.5 node dist/index.js gateway --port 19080",
          " 4322  4321  131072   1.5 node helper.js",
        ],
        expected: { aggregateRssMiB: 384, cpuPercent: 12.5, processId: 4321, rssMiB: 256 },
      },
      {
        name: "malformed CPU",
        lines: [" 4321     1  262144  12.5.6 node dist/index.js gateway --port 19080"],
        expected: { aggregateRssMiB: 256, cpuPercent: null, processId: 4321, rssMiB: 256 },
      },
      {
        name: "self-parenting process",
        lines: [" 4321  4321  262144  12.5 node dist/index.js gateway --port 19080"],
        expected: { aggregateRssMiB: 256, cpuPercent: 12.5, processId: 4321, rssMiB: 256 },
      },
      {
        name: "gateway child instead of launcher",
        lines: [
          " 4321     1   16384   0.0 node /usr/local/bin/corepack pnpm openclaw gateway --port 19080",
          " 4322  4321  262144  12.5 node dist/index.js gateway --port 19080 --bind loopback",
          " 4323  4322   32768   1.5 node helper.js",
        ],
        options: { commandLineNeedles: gatewayNeedles },
        expected: { aggregateRssMiB: 288, cpuPercent: 12.5, processId: 4322, rssMiB: 256 },
      },
      {
        name: "matching gateway root",
        lines: [
          " 4321     1  262144  12.5 node dist/index.js gateway --port 19080 --bind loopback\n",
        ],
        options: { commandLineNeedles: gatewayNeedles, platform: "darwin" },
        expected: { aggregateRssMiB: 256, cpuPercent: 12.5, processId: 4321, rssMiB: 256 },
      },
      ...["openclaw-gateway", "node"].map((command) => ({
        name: `fallback to ${command === "node" ? "largest child" : "gateway title"}`,
        lines: [
          " 4321     1 1048576   0.0 node /usr/local/bin/corepack pnpm openclaw gateway --port 19080",
          ` 4322  4321  262144  12.5 ${command}`,
          " 4323  4322   32768   1.5 node helper.js",
        ],
        options: {
          commandLineNeedles: gatewayNeedles,
          platform: command === "node" ? ("linux" as const) : ("darwin" as const),
        },
        expected: { aggregateRssMiB: 288, cpuPercent: 12.5, processId: 4322, rssMiB: 256 },
      })),
      {
        name: "missing gateway child",
        lines: [" 4321     1   16384   0.0 node /usr/local/bin/corepack pnpm openclaw status\n"],
        options: { commandLineNeedles: gatewayNeedles, platform: "darwin" },
        expected: null,
      },
    ];
    if (process.platform !== "win32") {
      for (const badRow of [
        "  5678  1234  9007199254740993  0.2 child",
        "  5678x  1234  2048  0.2 child",
        "  5678  1234x  2048  0.2 child",
      ]) {
        rows.push({
          name: `malformed sampled row ${badRow}`,
          lines: [
            "  PID  PPID   RSS %CPU COMMAND",
            "  1234     1  2048  0.1 openclaw-gateway",
            badRow,
          ],
          options: { pid: 1234 },
          expected: null,
        });
      }
      rows.push({
        name: "malformed unrelated row",
        lines: [
          "  PID  PPID   RSS %CPU COMMAND",
          "  1234     1  2048  0.1 openclaw-gateway",
          "  5678  1234  4096  0.2 child",
          "  9999  9998  9007199254740993  0.2 unrelated",
        ],
        options: { pid: 1234 },
        expected: { aggregateRssMiB: 6, cpuPercent: 0.1, processId: 1234, rssMiB: 2 },
      });
    }
    for (const { name, lines, options, expected } of rows) {
      expect(await samplePosixSnapshot(lines.join("\n"), options), name).toEqual(expected);
    }
  });

  it("retries transient loopback fetch resets from Windows HTTP probes", async () => {
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(new Response('{"status":"live"}', { status: 200 }));

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 2,
        fetchImpl,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true, status: 200, body: { status: "live" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts HTTP probe retry backoff when the external signal fires", async () => {
    const controller = new AbortController();
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi.fn().mockRejectedValue(reset);
    const startedAt = Date.now();

    setTimeout(() => {
      controller.abort(new Error("gateway exited before ready"));
    }, 25);

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 2,
        fetchImpl,
        retryDelayMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("gateway exited before ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("bounds HTTP probe response bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(1025), { status: 200 }));

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 1,
        fetchImpl,
        maxBodyBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
  });

  it("clamps oversized HTTP probe timeouts before scheduling timers", async () => {
    const fetchImpl = vi.fn(async () => {
      await delay(25);
      return new Response('{"status":"live"}', { status: 200 });
    });

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 1,
        fetchImpl,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toEqual({ ok: true, status: 200, body: { status: "live" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels stalled HTTP probe response streams when the external signal fires", async ({
    signal,
  }) => {
    const readStarted = createDeferred();
    const canceled = createDeferred();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            readStarted.resolve();
            return new Promise(() => {});
          },
          cancel() {
            canceled.resolve();
          },
        }),
        { status: 200 },
      ),
    );

    const result = fetchJson("http://127.0.0.1:19680/readyz", {
      attempts: 1,
      fetchImpl,
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    const rejection = expect(result).rejects.toThrow("gateway exited before ready");

    try {
      await withinTest(
        awaitGateBeforeSettlement(readStarted.promise, result, "timed out waiting for condition"),
        signal,
      );
      controller.abort(new Error("gateway exited before ready"));

      await withinTest(rejection, signal);
      await withinTest(canceled.promise, signal);
    } finally {
      controller.abort(new Error("gateway exited before ready"));
      await rejection;
    }
  });

  it("times out stalled HTTP probe response bodies", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
        { status: 200 },
      ),
    );

    const result = fetchJson("http://127.0.0.1:19680/readyz", {
      attempts: 1,
      fetchImpl,
      timeoutMs: 100,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "fetch http://127.0.0.1:19680/readyz timed out after 100ms",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it.each([false, true])("enforces RSS locally and warns in Actions (%s)", (actions) => {
    vi.stubEnv("GITHUB_ACTIONS", actions ? "true" : "");
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [assertCeiling, sample, message] of [
      [assertResourceCeiling, { rssMiB: 2049 }, "gateway RSS exceeded 2048 MiB: 2049 MiB"],
      [
        assertResourceCeiling,
        { aggregateRssMiB: 2049, rssMiB: 1024 },
        "gateway aggregate RSS exceeded 2048 MiB: 2049 MiB",
      ],
      [
        assertCommandResourceCeiling,
        { aggregateRssMiB: 8193, rssMiB: 1024 },
        "command aggregate RSS exceeded 8192 MiB: 8193 MiB",
      ],
    ] as const) {
      if (actions) {
        expect(() => assertCeiling(sample)).not.toThrow();
        expect(report).toHaveBeenCalledWith(expect.stringContaining(`::${message}`));
      } else {
        expect(() => assertCeiling(sample)).toThrow(message);
      }
    }
    if (actions) {
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining(
          "::warning file=scripts/e2e/kitchen-sink-rpc-walk.mts,line=1,col=0",
        ),
      );
    }
  });

  it("summarizes peak RSS across repeated process samples", () => {
    expect(
      summarizeProcessSamples([
        { aggregateRssMiB: 128, rssMiB: 128, cpuPercent: 2 },
        { aggregateRssMiB: 768, rssMiB: 512, cpuPercent: 25 },
        { aggregateRssMiB: 1024, rssMiB: 256, cpuPercent: 8 },
      ]),
    ).toEqual({
      aggregateRssMiB: 1024,
      rssMiB: 256,
      cpuPercent: 8,
      sampleCount: 3,
      peakCpuPercent: 25,
    });
  });

  it.each(["", "true"])("rejects missing and invalid RSS in Actions mode %s", (actions) => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    expect(() => assertResourceCeiling(null)).toThrow("gateway RSS sample was not captured");
    expect(() => assertCommandResourceCeiling(null)).toThrow("command RSS sample was not captured");
    expect(() => assertResourceCeiling({ rssMiB: 0 })).toThrow(
      "gateway RSS sample was invalid: 0 MiB",
    );
    expect(() => assertCommandResourceCeiling({ aggregateRssMiB: 0, rssMiB: 128 })).toThrow(
      "command aggregate RSS sample was invalid: 0 MiB",
    );
  });
});

function readText(file: string) {
  return readFileSync(file, "utf8");
}

// runCommand bounds its group probe; it cannot join a foreign descendant's
// kernel exit. Keep that observation deadline-free and tied to the test lifetime.
async function waitForProcessExit(pid: number, signal: AbortSignal) {
  while (isProcessAlive(pid)) {
    try {
      await realDelay(25, undefined, { signal });
    } catch (cause) {
      throw new Error(`timed out waiting for condition: process ${pid} to exit`, { cause });
    }
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
