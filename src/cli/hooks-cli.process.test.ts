import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildNativeHookRelayCommand,
  registerOwnedNativeHookRelay,
  testing as nativeHookRelayTesting,
} from "../agents/harness/native-hook-relay.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { getFreePort } from "../test-utils/ports.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { writeCliPluginFixture, writeFixtureJson } from "./cli-fixtures.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
// Process startup includes TS transforms and plugin discovery, both of which can
// stall behind neighboring CI shards. Bound observable milestones, not runner speed.
const outputTimeoutMs = 45_000;
const exitAfterOutputTimeoutMs = 30_000;
const exitOnlyTimeoutMs = 60_000;

afterEach(async () => {
  await nativeHookRelayTesting.clearNativeHookRelaysForTests();
  await Promise.all(Array.from(activeChildren, terminateChild));
});

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

async function createLingeringPluginFixture() {
  const root = tempDirs.make("openclaw-hooks-cli-");
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "linger-plugin");
  const markerPath = path.join(root, "registered");
  await fs.mkdir(stateDir, { recursive: true });
  await writeCliPluginFixture(
    pluginDir,
    "linger-plugin",
    { id: "linger", name: "Linger", activation: { onCapabilities: ["hook"] } },
    [
      'import fs from "node:fs";',
      "export default {",
      '  id: "linger",',
      '  name: "Linger",',
      "  register(api) {",
      '    fs.writeFileSync(process.env.LINGER_MARKER, "registered\\n");',
      '    api.registerHook("command:new", () => {}, { name: "fixture-hook", description: "Fixture hook" });',
      "    const timer = setInterval(() => {}, 60_000);",
      '    api.lifecycle.onDispose(() => { clearInterval(timer); fs.appendFileSync(process.env.LINGER_MARKER, "disposed\\n"); });',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  await writeFixtureJson(configPath, {
    plugins: {
      load: { paths: [pluginDir] },
      entries: { linger: { enabled: true } },
    },
  });
  return { configPath, markerPath, stateDir };
}

async function createRelayPreloadFixture(
  mode: "natural-exit" | "missing-drain-callbacks" = "natural-exit",
) {
  const root = tempDirs.make("openclaw-hooks-relay-");
  const markerPath = path.join(root, "loaded");
  const preloadPath = path.join(root, "natural-exit.mjs");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.LINGER_MARKER, "loaded\\n");',
      'process.exit = () => { throw new Error("unexpected forced process exit"); };',
      ...(mode === "natural-exit"
        ? []
        : [
            "for (const stream of [process.stdout, process.stderr]) {",
            "  const write = stream.write.bind(stream);",
            '  stream.write = (chunk, ...args) => chunk === "" ? true : write(chunk, ...args);',
            "}",
          ]),
      "",
    ].join("\n"),
  );
  return { markerPath, preloadPath, stateDir };
}

async function createTimeoutOwnershipFixture() {
  const root = tempDirs.make("openclaw-hooks-timeout-owner-");
  const nodeWrapperPath = path.join(root, "node-with-tsx");
  const pidLogPath = path.join(root, "pids");
  const preloadPath = path.join(root, "track-relay-pid.mjs");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.RELAY_PID_LOG, `${process.pid}\\n`);",
      "const originalAsyncIterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);",
      "process.stdin[Symbol.asyncIterator] = function () {",
      "  process.stdout.write(`relay-ready:${process.pid}\\n`);",
      "  return originalAsyncIterator();",
      "};",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    nodeWrapperPath,
    ["#!/bin/sh", 'exec "$OPENCLAW_TEST_NODE" --import tsx "$@"', ""].join("\n"),
  );
  await fs.chmod(nodeWrapperPath, 0o755);
  return { nodeWrapperPath, pidLogPath, preloadPath, stateDir };
}

async function readPidFile(filePath: string): Promise<number[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function relayEnv(fixture: Awaited<ReturnType<typeof createRelayPreloadFixture>>) {
  return {
    LINGER_MARKER: fixture.markerPath,
    NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
    OPENCLAW_STATE_DIR: fixture.stateDir,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function relayArgs(relayId: string, ...args: string[]) {
  return [
    "hooks",
    "relay",
    "--provider",
    "codex",
    "--relay-id",
    relayId,
    "--event",
    "post_tool_use",
    ...args,
  ];
}

async function runHooksCli(params: {
  args: string[];
  completion: "exit" | "output-then-exit";
  entryPath?: string;
  entryArgv?: string[];
  label: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  stdin?: string;
}) {
  const gate = createDeferred();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputObserved = false;
  let timedOut = false;
  const arm = (ms: number, milestone: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      gate.reject(new Error(`${params.label} did not ${milestone} within ${ms}ms`));
    }, ms);
  };
  try {
    return await runCliProcessChild({
      nodeExecutable: params.nodeExecutable,
      nodeArgsPolicy: "caller",
      nodeArgs: [
        ...(params.entryArgv ?? ["--import", "tsx", params.entryPath ?? "src/entry.ts"]),
        ...params.args,
      ],
      env: { ...process.env, NODE_ENV: undefined, VITEST: undefined, ...params.env },
      timeoutMs:
        params.completion === "exit"
          ? exitOnlyTimeoutMs
          : outputTimeoutMs + exitAfterOutputTimeoutMs,
      interact(child) {
        arm(
          params.completion === "exit" ? exitOnlyTimeoutMs : outputTimeoutMs,
          params.completion === "exit" ? "exit" : "emit output",
        );
        child.once("close", () => gate.resolve());
        child.stdin.end(params.stdin ?? "");
        return gate.promise;
      },
      onStdout() {
        if (!timedOut && params.completion !== "exit" && !outputObserved) {
          outputObserved = true;
          arm(exitAfterOutputTimeoutMs, "exit after emitting output");
        }
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

describe("hooks CLI process lifecycle", () => {
  it.each([
    {
      name: "invalid JSON",
      preloadMode: "natural-exit" as const,
      args: relayArgs("ordinary-input"),
      stdin: "{",
      diagnostic: "failed to read native hook input",
    },
    {
      name: "missing drain callbacks with no lingering handle",
      preloadMode: "missing-drain-callbacks" as const,
      args: ["hooks", "relay"],
      stdin: "",
      diagnostic: "native hook relay failed: Missing required option --provider",
    },
  ])(
    "preserves a dedicated relay $name failure when exiting",
    async ({ args, stdin, diagnostic, preloadMode }) => {
      const fixture = await createRelayPreloadFixture(preloadMode);
      const result = await runHooksCli({
        entryPath: "src/cli/native-hook-relay-entry.ts",
        args,
        stdin,
        completion: "exit",
        label: "dedicated relay error",
        nodeExecutable: resolveTestNodeExecPath(),
        env: relayEnv(fixture),
      });
      expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(diagnostic);
      expect(result.stderr.endsWith("\n")).toBe(true);
      await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("loaded\n");
    },
    90_000,
  );

  it.runIf(process.platform !== "win32")(
    "keeps the relay on the timeout-owned shell PID",
    async ({ signal }) => {
      const fixture = await createTimeoutOwnershipFixture();
      const command = buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "timeout-owner",
        event: "post_tool_use",
        executable: path.resolve("src/entry.ts"),
        nodeExecutable: fixture.nodeWrapperPath,
        timeoutMs: 60_000,
      });
      const child = spawn("/bin/sh", ["-lc", command], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          NODE_ENV: undefined,
          VITEST: undefined,
          NODE_COMPILE_CACHE: path.join(fixture.stateDir, "node-compile-cache"),
          NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: fixture.stateDir,
          OPENCLAW_TEST_NODE: resolveTestNodeExecPath(),
          RELAY_PID_LOG: fixture.pidLogPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeChildren.add(child);
      const closed = once(child, "close");
      const ready = createDeferred<number>();
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const pid = /relay-ready:(\d+)\n/.exec(stdout)?.[1];
        if (pid) {
          ready.resolve(Number(pid));
        }
      });
      child.once("close", () => activeChildren.delete(child));
      const timeoutOwnedPid = child.pid;
      if (!timeoutOwnedPid) {
        throw new Error("Expected native hook relay shell PID");
      }

      try {
        const readyPid = await withinTest(
          awaitGateBeforeSettlement(
            ready.promise,
            closed,
            "native hook relay exited before writing its ready marker",
          ),
          signal,
        );
        expect(readyPid).toBe(timeoutOwnedPid);
        expect(new Set(await readPidFile(fixture.pidLogPath))).toEqual(new Set([timeoutOwnedPid]));

        expect(child.kill("SIGKILL")).toBe(true);
        await withinTest(closed, signal);
        // Every recorded relay is the reaped shell PID; close also joins its output streams.
        expect(isProcessAlive(timeoutOwnedPid)).toBe(false);
        expect(
          (await readPidFile(fixture.pidLogPath)).filter((pid) => isProcessAlive(pid)),
        ).toEqual([]);
      } finally {
        await terminateChild(child);
        for (const pid of await readPidFile(fixture.pidLogPath)) {
          if (pid !== timeoutOwnedPid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    60_000,
  );

  it.each(["src/entry.ts", "src/cli/native-hook-relay-entry.ts"])(
    "%s uses the explicit relay database and exits naturally",
    async (entryPath) => {
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "process-explicit-state-db",
        sessionId: "session-1",
        runId: "run-1",
        allowedEvents: ["post_tool_use"],
      });
      await relay.ready;
      expect(
        await nativeHookRelayTesting.getNativeHookRelayBridgeRecordForTests(relay.relayId),
      ).toBeDefined();

      const fixture = await createRelayPreloadFixture();
      const result = await runHooksCli({
        entryPath,
        args: relayArgs(
          relay.relayId,
          "--state-db",
          resolveOpenClawStateSqlitePath(),
          "--generation",
          relay.generation,
          "--timeout",
          "5000",
        ),
        completion: "exit",
        label: "hooks relay explicit state database",
        nodeExecutable: resolveTestNodeExecPath(),
        env: {
          ...relayEnv(fixture),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        stdin: JSON.stringify({ hook_event_name: "PostToolUse" }),
      });

      expect(result, result.stderr).toEqual({ code: 0, signal: null, stderr: "", stdout: "" });
      await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("loaded\n");
    },
    90_000,
  );

  it("joins the plugin-owned handle after hooks list output", async () => {
    const fixture = await createLingeringPluginFixture();
    const unavailableGatewayPort = await getFreePort();

    const listResult = await runHooksCli({
      // Prepare CLI code before timing the fresh process and its plugin lifecycle.
      entryArgv: resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
      args: ["hooks", "list", "--json"],
      completion: "output-then-exit",
      label: "hooks list",
      env: {
        LINGER_MARKER: fixture.markerPath,
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_PORT: String(unavailableGatewayPort),
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
    });

    expect(listResult, listResult.stderr).toMatchObject({ code: 0, signal: null });
    expect(listResult.stderr).not.toContain("Error:");
    expect(JSON.parse(listResult.stdout)).toMatchObject({
      hooks: expect.arrayContaining([expect.objectContaining({ name: "fixture-hook" })]),
    });
    await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("registered\ndisposed\n");
  }, 150_000);
});
