import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type TestContext, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import {
  childClosed,
  fixtureReadySource,
  killPidIfAlive,
  readCompletedPidFile,
  pidIsAlive,
  registerFixtureCleanup,
  registerRuntimeCommandOutputTimeoutTest,
  registerRuntimeCommandTimeoutTests,
  waitForDead,
  waitForPidFile,
} from "./bundled-plugin-runtime-command.test-support.js";

const tempDirs: string[] = [];
const probePath = path.resolve("scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs");
const runtimeSmokePath = path.resolve(
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
);
const sweepPath = path.resolve("scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh");
let runtimeSmoke: typeof import("../../scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs");
beforeEach(async () => {
  runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
});

const teardownEnv = {
  OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS: "50",
  OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS: "1000",
};

type PluginListEntry = {
  id: string;
  origin: string;
  rootDir: string;
};

function createPackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-probe-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  return root;
}

function makePackageRoot(): string {
  const root = createPackageRoot();
  tempDirs.push(root);
  return root;
}

function writeSource(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

function descendantSource(pidPath: string, notifyParent = false): string {
  return [
    "import fs from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + "\\n");`,
    fixtureReadySource(pidPath),
    ...(notifyParent ? ["process.send('ready');", "process.disconnect();"] : []),
  ].join("\n");
}

function runnerFixture(
  root: string,
  runnerPath: string,
  pidPath: string,
  onTestFinished: TestContext["onTestFinished"],
  env = process.env,
) {
  const runner = spawn(process.execPath, [runnerPath], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const closed = childClosed(runner);
  let descendantPid: number | undefined;
  const cleanup = registerFixtureCleanup(onTestFinished, async () => {
    if (runner.pid && pidIsAlive(runner.pid)) {
      runner.kill("SIGTERM");
    }
    await closed;
    killPidIfAlive(descendantPid ?? readCompletedPidFile(pidPath));
    fs.rmSync(root, { force: true, recursive: true });
  });
  const waitForDescendant = async (signal: AbortSignal) =>
    (descendantPid = await waitForPidFile(pidPath, closed, signal));
  return { runner, closed, cleanup, waitForDescendant };
}

function logFixture(content?: string): string {
  const logPath = path.join(makePackageRoot(), "gateway.log");
  if (content !== undefined) {
    fs.writeFileSync(logPath, content, "utf8");
  }
  return logPath;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeGatewayWithChild(entrypoint: string, script: string, exitOnReady = false) {
  writeSource(entrypoint, [
    "import childProcess from 'node:child_process';",
    "if (process.argv[2] === 'gateway') {",
    `  const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(script)}], { stdio: ${exitOnReady ? '["ignore", "ignore", "ignore", "ipc"]' : '"ignore"'} });`,
    ...(exitOnReady
      ? ["  child.once('message', () => process.exit(0));"]
      : ["  process.on('SIGTERM', () => process.exit(0));", "  setInterval(() => {}, 1000);"]),
    "}",
    "",
  ]);
}

function writePluginsList(root: string, plugins: PluginListEntry[], diagnostic = false): void {
  writeSource(path.join(root, "dist", "index.js"), [
    `const plugins = ${JSON.stringify(plugins)};`,
    "if (process.argv.slice(2).join(' ') !== 'plugins list --json') {",
    "  console.error(`unexpected argv: ${process.argv.slice(2).join(' ')}`);",
    "  process.exit(1);",
    "}",
    "console.log(JSON.stringify({ plugins }));",
    ...(diagnostic
      ? ["console.log(JSON.stringify({ level: 'warn', message: 'post-list diagnostic' }));"]
      : []),
    "",
  ]);
}

function pluginFixture(
  plugins: { id: string; directory: string; configSchema?: Record<string, unknown> }[],
  diagnostic = false,
) {
  const root = makePackageRoot();
  const entries = plugins.map(({ id, directory, configSchema }) => {
    writePluginManifest(root, directory, { id, ...(configSchema ? { configSchema } : {}) });
    return { id, origin: "bundled", rootDir: path.join(root, directory) };
  });
  writePluginsList(root, entries, diagnostic);
  return { root, entries };
}

function writePluginManifest(root: string, pluginRoot: string, manifest: Record<string, unknown>) {
  const dir = path.join(root, pluginRoot);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "openclaw.plugin.json"), manifest);
}

function writeInstalledPlugin(root: string, sourcePath: string): string {
  return writePluginState(
    root,
    { plugins: { entries: { nostr: { enabled: true } } } },
    { nostr: { source: "path", sourcePath, installPath: sourcePath } },
  );
}

function writePluginState(root: string, config: unknown, installRecords = {}) {
  const stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
  writeJson(path.join(stateDir, "openclaw.json"), config);
  writeJson(path.join(stateDir, "plugins", "installs.json"), { installRecords });
  writePluginsList(root, []);
  return stateDir;
}

function runStateProbe(root: string, stateDir: string, args: string[]) {
  return runProbeCommand(root, args, { HOME: undefined, OPENCLAW_STATE_DIR: stateDir });
}

function runProbe(root: string, env: Record<string, string | undefined> = {}) {
  return runProbeCommand(root, ["select"], env);
}

function runProbeCommand(root: string, args: string[], env: Record<string, string | undefined>) {
  const childEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined),
  );
  return runScript(root, probePath, args, childEnv);
}

function runScript(root: string, script: string, args: string[], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, OPENCLAW_ENTRY: path.join(root, "dist", "index.js") },
  });
}

function runRuntimeSmoke(root: string, args: string[]) {
  return runScript(root, runtimeSmokePath, args);
}

async function importRuntimeSmokeWithEnv(env: Record<string, string | undefined>) {
  return withEnvAsync(
    env,
    () => import(`${pathToFileURL(runtimeSmokePath).href}?case=${Date.now()}-${Math.random()}`),
  );
}

async function listenOnLoopback(server: HttpServer | NetServer): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

async function closeServer(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      return error ? reject(error) : resolve();
    });
  });
}

async function withServer(
  server: HttpServer | NetServer,
  run: (port: number) => Promise<void>,
  beforeClose = () => {},
) {
  try {
    await run(await listenOnLoopback(server));
  } finally {
    beforeClose();
    await closeServer(server);
  }
}

async function withStalledServer(run: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await withServer(server, run, () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

function runnerMessage(runner: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown) => {
      if (message === expected) {
        runner.off("message", onMessage);
        resolve();
      }
    };
    runner.on("message", onMessage);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("bundled plugin install/uninstall probe", () => {
  it("waits for complete PID files before probing or killing a process", async () => {
    const root = makePackageRoot();
    const pidPath = path.join(root, "child.pid");
    fs.writeFileSync(pidPath, "", "utf8");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const published = createDeferred();
    const pendingPid = published.promise.then(() => readCompletedPidFile(pidPath));
    expect(readCompletedPidFile(pidPath)).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    fs.writeFileSync(pidPath, "123", "utf8");
    expect(readCompletedPidFile(pidPath)).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    fs.writeFileSync(pidPath, "123\n", "utf8");
    published.resolve();

    await expect(pendingPid).resolves.toBe(123);
    killPidIfAlive(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores ESRCH when a probed process exits before cleanup", () => {
    const killError = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const kill = vi
      .spyOn(process, "kill")
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw killError;
      });

    expect(() => killPidIfAlive(123)).not.toThrow();
    expect(kill).toHaveBeenNthCalledWith(1, 123, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 123, "SIGKILL");
  });

  it("keeps the sweep script compatible with macOS Bash 3", () => {
    const sweep = fs.readFileSync(sweepPath, "utf8");

    expect(sweep).not.toContain("mapfile ");
    expect(sweep).not.toContain("readarray ");
  });

  it("bounds bundled plugin package lifecycle commands", () => {
    const sweep = fs.readFileSync(sweepPath, "utf8");

    expect(sweep).toContain("source scripts/lib/docker-e2e-logs.sh");
    expect(sweep).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_COMMAND_TIMEOUT:-300s");
    expect(sweep.match(/openclaw_e2e_maybe_timeout/g)).toHaveLength(1);
    expect(sweep).toContain('run_logged_sweep_command "install $plugin_id"');
    expect(sweep).toContain('run_logged_sweep_command "uninstall $plugin_id"');
    expect(sweep.match(/docker_e2e_print_log/g)).toHaveLength(3);
    expect(sweep).not.toContain('cat "$log_file"');
    expect(sweep).not.toContain('cat "$install_log"');
    expect(sweep).not.toContain('cat "$uninstall_log"');
  });

  it("uses the runtime output limit for command capture", async () => {
    runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS: "5",
    });

    await expect(
      runtimeSmoke.runCommand(process.execPath, [
        "-e",
        "process.stdout.write('abcdef'); process.stderr.write('UVWXYZ');",
      ]),
    ).resolves.toEqual({
      stdout: "bcdef",
      stderr: "VWXYZ",
      stdoutTruncatedChars: 1,
      stderrTruncatedChars: 1,
    });
  });

  it("preserves explicit nullish runtime RPC result fields", async () => {
    expect(runtimeSmoke.unwrapRpcPayload({ jsonrpc: "2.0", result: null })).toBeNull();
    expect(runtimeSmoke.unwrapRpcPayload({ jsonrpc: "2.0", result: undefined })).toBeUndefined();
    expect(runtimeSmoke.unwrapRpcPayload({ payload: null, data: { stale: true } })).toBeNull();
  });

  it("rejects incomplete runtime health RPC payloads", async () => {
    expect(() =>
      runtimeSmoke.assertGatewayHealthPayload({
        agents: [],
        channelOrder: [],
        channels: {},
        defaultAgentId: "codex",
        durationMs: 3,
        ok: true,
        sessions: { count: 0, path: "/state/sessions", recent: [] },
        ts: Date.now(),
      }),
    ).not.toThrow();
    expect(() => runtimeSmoke.assertGatewayHealthPayload({ ok: true })).toThrow(
      "health returned invalid payload: expected numeric ts.",
    );
    expect(() => runtimeSmoke.assertGatewayHealthPayload({}, "watchdog health")).toThrow(
      "watchdog health returned invalid payload: expected ok=true.",
    );
  });

  it("rejects loose bundled plugin runtime index args", () => {
    const root = makePackageRoot();

    const result = runRuntimeSmoke(root, ["tts-openai-live", "", "", "", "1e3"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid bundled plugin runtime index: 1e3");
  });

  it.each([
    ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS", "9007199254740992"],
    ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS", "5chars"],
  ])("rejects invalid %s=%s", async (name, value) => {
    await expect(importRuntimeSmokeWithEnv({ [name]: value })).rejects.toThrow(
      `invalid ${name}: ${value}`,
    );
  });

  it("rejects bundled plugin runtime ports outside the TCP range", async () => {
    const env = {
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE: "65533",
    };

    expect(runtimeSmoke.resolveRuntimeSmokePort(0, 2, env)).toBe(65535);
    expect(() => runtimeSmoke.resolveRuntimeSmokePort(1, 0, env)).toThrow(
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE with bundled plugin runtime index 1 and offset 0 must resolve to a TCP port from 1 to 65535. Got: 65536",
    );
  });

  it("caps noisy runtime gateway logs", async ({ signal, onTestFinished }) => {
    runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_GATEWAY_LOG_BYTES: "64",
    });
    const root = createPackageRoot();
    const entrypoint = path.join(root, "dist", "noisy-gateway.js");
    const logPath = path.join(root, "gateway.log");
    writeSource(entrypoint, [
      "if (process.argv[2] === 'gateway') {",
      "  process.stdout.write('x'.repeat(2048));",
      "  setInterval(() => {}, 1000);",
      "}",
      "",
    ]);

    const child = runtimeSmoke.startGateway({
      entrypoint,
      env: {},
      logPath,
      port: 19002,
      skipChannels: true,
    });
    const marker = "[gateway log truncated after 64 bytes]";
    const logged = createDeferred();
    const closed = childClosed(child);
    // startGateway's earlier data listener commits the bounded log synchronously.
    const onOutput = () => {
      if (fs.readFileSync(logPath, "utf8").includes(marker)) {
        logged.resolve();
      }
    };
    child.stdout.on("data", onOutput);
    const cleanup = registerFixtureCleanup(onTestFinished, async () => {
      child.stdout.off("data", onOutput);
      await runtimeSmoke.stopGateway(child);
      await closed;
      fs.rmSync(root, { force: true, recursive: true });
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(logged.promise, closed, `gateway log missing ${marker}`),
        signal,
      );

      const log = fs.readFileSync(logPath, "utf8");
      expect(log).toContain(marker);
      expect(log.length).toBeLessThan(256);
      expect(() => runtimeSmoke.assertGatewayLogNotTruncated(logPath)).toThrow(
        /runtime smoke cannot validate complete post-ready output/u,
      );
    } finally {
      await cleanup();
    }
  });

  it("rejects an enabled plugin that failed during gateway load", async () => {
    const logPath = logFixture(
      "[gateway] ready\n[plugins] cua-computer failed to load from /app/dist/extensions/cua-computer/index.js: missing libX11",
    );

    expect(() => runtimeSmoke.assertPluginLoaded(logPath, "cua-computer")).toThrow(
      /cua-computer failed to load/u,
    );
    expect(() => runtimeSmoke.assertPluginLoaded(logPath, "slack")).not.toThrow();
  });

  it("matches runtime slash aliases across command list surfaces", async () => {
    const payload = {
      commands: [{ name: "voicecall" }, { nativeName: "demo" }, { textAliases: ["/pair"] }],
    };

    expect(
      ["/voicecall", "/demo", "/pair", "/missing"].map((command) =>
        runtimeSmoke.isCommandVisible(payload, command),
      ),
    ).toEqual([true, true, true, false]);
  });

  it("fails runtime smoke when declared channels are absent from status", async () => {
    expect(() =>
      runtimeSmoke.assertChannelVisible(
        { channelMeta: [{ id: "qa-channel" }] },
        "qa-channel",
        "qa-channel",
      ),
    ).not.toThrow();
    expect(() => runtimeSmoke.assertChannelVisible({}, "qa-channel", "qa-channel")).toThrow(
      "Runtime channel status missing manifest channel qa-channel for qa-channel",
    );
  });

  it("activates channel config for channel plugin runtime smoke", async () => {
    expect(
      runtimeSmoke.activateSmokePlugin(
        { plugins: { allow: ["browser"] }, channels: { telegram: { dmPolicy: "open" } } },
        "telegram",
        ["telegram"],
      ),
    ).toMatchObject({
      channels: { telegram: { dmPolicy: "open", enabled: true } },
      plugins: {
        allow: ["browser", "telegram"],
        enabled: true,
        entries: { telegram: { enabled: true } },
      },
    });
  });

  it("adds channel-prefixed env activation markers for runtime smoke startup", async () => {
    expect(
      runtimeSmoke.withManifestChannelActivationEnv({ TELEGRAM_RUNTIME_SMOKE: "kept" }, [
        "clickclack",
        "nextcloud-talk",
        "telegram",
      ]),
    ).toMatchObject({
      CLICKCLACK_RUNTIME_SMOKE: "1",
      NEXTCLOUD_TALK_RUNTIME_SMOKE: "1",
      TELEGRAM_RUNTIME_SMOKE: "kept",
    });
  });

  it("keeps runtime log tail reads bounded", async () => {
    const logPath = logFixture(`${"old log line\n".repeat(1000)}[gateway] ready\n`);

    const fullRead = vi.spyOn(fs, "readFileSync");
    const tail = runtimeSmoke.readFileTail(logPath, 64);

    expect(tail).toContain("[gateway] ready");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("remembers runtime ready logs after they fall outside the tail", async () => {
    const logPath = logFixture();
    const readyLogSeen = runtimeSmoke.createReadyLogScanner(logPath);

    fs.writeFileSync(logPath, `[gateway] ready\n${"x".repeat(300_000)}`, "utf8");

    expect(readyLogSeen()).toBe(true);

    fs.appendFileSync(logPath, "more log output".repeat(30_000), "utf8");

    expect(readyLogSeen()).toBe(true);
  });

  it("treats signaled gateway children as already stopped", async () => {
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: "SIGTERM",
    };

    expect(runtimeSmoke.hasChildExited(child)).toBe(true);
    await runtimeSmoke.stopGateway(child);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { label: "successful", firstStatus: 0 },
    { label: "graceful fallback", firstStatus: 1 },
  ])("signals Windows process trees with $label taskkill", async ({ firstStatus }) => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: firstStatus })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    runtimeSmoke.signalChildProcessTree(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    if (firstStatus === 0) {
      runtimeSmoke.signalChildProcessTree(child, "SIGKILL", {
        platform: "win32",
        runTaskkill,
      });
    }
    expect(runTaskkill.mock.calls).toEqual([
      [resolveWindowsTaskkillPath(), ["/PID", "12345", "/T"], { stdio: "ignore" }],
      [resolveWindowsTaskkillPath(), ["/PID", "12345", "/T", "/F"], { stdio: "ignore" }],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").for([
    { name: "stops runtime gateway process groups", packageManager: false, port: 19003 },
    {
      name: "rejects package-manager grandchildren under runtime gateways",
      packageManager: true,
      port: 19007,
    },
  ])("$name", async ({ packageManager, port }, { signal, onTestFinished }) => {
    runtimeSmoke = await importRuntimeSmokeWithEnv(teardownEnv);
    const root = createPackageRoot();
    const entrypoint = path.join(root, "dist", "gateway-with-sidecar.js");
    const logPath = path.join(root, "gateway.log");
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantScript = packageManager
      ? [
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          'const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { argv0: "pnpm", stdio: "ignore" });',
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid) + "\\n");`,
          fixtureReadySource(descendantPidPath),
          "process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });",
          "setInterval(() => {}, 1000);",
        ].join("\n")
      : descendantSource(descendantPidPath);
    writeGatewayWithChild(entrypoint, descendantScript);

    const child = runtimeSmoke.startGateway({
      entrypoint,
      env: {},
      logPath,
      port,
      skipChannels: true,
    });
    const closed = childClosed(child);
    let descendantPid: number | undefined;
    const cleanup = registerFixtureCleanup(onTestFinished, async () => {
      if (!packageManager) {
        killPidIfAlive(descendantPid ?? readCompletedPidFile(descendantPidPath));
      }
      await runtimeSmoke.stopGateway(child);
      if (packageManager) {
        killPidIfAlive(descendantPid ?? readCompletedPidFile(descendantPidPath));
      }
      await closed;
      fs.rmSync(root, { force: true, recursive: true });
    });
    try {
      descendantPid = await waitForPidFile(descendantPidPath, closed, signal);
      expect(pidIsAlive(descendantPid)).toBe(true);

      if (packageManager) {
        await expect(runtimeSmoke.assertNoPackageManagerChildren(child.pid)).rejects.toThrow(
          /package manager descendant process still running/u,
        );
      } else {
        await runtimeSmoke.stopGateway(child);
        await waitForDead(descendantPid, signal);
      }
    } finally {
      await cleanup();
    }
  });

  // These cases install parent signal handlers and manipulate real process groups.
  // Keep them serial so one teardown cannot signal another case's child tree.
  registerRuntimeCommandTimeoutTests(createPackageRoot);

  it
    .runIf(process.platform !== "win32")
    .for(["command running", "command settled", "gateway closed"])(
    "cleans descendant groups on parent signal after %s",
    async (state, { signal, onTestFinished }) => {
      const gateway = state === "gateway closed";
      const commandSettled = state === "command settled";
      const root = createPackageRoot();
      const commandPath = path.join(root, "closed-command.mjs");
      const runnerPath = path.join(root, "run-closed-runtime-command.mjs");
      const descendantPidPath = path.join(root, "closed-command-descendant.pid");
      const descendantScript = descendantSource(descendantPidPath, gateway);
      if (gateway) {
        writeGatewayWithChild(commandPath, descendantScript, true);
      } else {
        writeSource(commandPath, [
          "import childProcess from 'node:child_process';",
          `const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          commandSettled ? "child.unref();" : "setInterval(() => {}, 1000);",
          "",
        ]);
      }
      const readyMessage = gateway ? "gateway-closed" : "command-settled";
      const operation = gateway
        ? [
            `const gateway = runtimeSmoke.startGateway(${JSON.stringify({
              entrypoint: commandPath,
              env: {},
              logPath: path.join(root, "gateway.log"),
              port: 19004,
              skipChannels: true,
            })});`,
            "gateway.once('close', () => process.send('gateway-closed'));",
          ]
        : [
            `runtimeSmoke.runCommand(process.execPath, [${JSON.stringify(commandPath)}], { timeoutMs: 60_000 })`,
            commandSettled
              ? ".finally(() => process.send('command-settled'));"
              : ".catch(() => undefined);",
          ];
      writeSource(runnerPath, [
        `const runtimeSmoke = await import(${JSON.stringify(pathToFileURL(runtimeSmokePath).href)});`,
        ...operation,
        "setInterval(() => {}, 1000);",
        "",
      ]);

      const { runner, closed, cleanup, waitForDescendant } = runnerFixture(
        root,
        runnerPath,
        descendantPidPath,
        onTestFinished,
        gateway ? { ...process.env, ...teardownEnv } : process.env,
      );
      const settled = runnerMessage(runner, readyMessage);
      try {
        const descendantPid = await waitForDescendant(signal);
        expect(pidIsAlive(descendantPid)).toBe(true);
        if (commandSettled || gateway) {
          await withinTest(
            awaitGateBeforeSettlement(settled, closed, `timeout waiting for ${readyMessage}`),
            signal,
          );
        }

        runner.kill("SIGTERM");

        await waitForDead(descendantPid, signal);
      } finally {
        await cleanup();
      }
    },
  );

  it("scans only post-ready runtime logs for dependency work", async () => {
    const logPath = logFixture(
      `pre-ready npm install is allowed here\n${"x".repeat(300_000)}\n[gateway] ready\nruntime ok\n`,
    );

    const fullRead = vi.spyOn(fs, "readFileSync");
    const readyOffset = runtimeSmoke.findReadyLogOffset(logPath);

    expect(() => runtimeSmoke.assertNoPostReadyRuntimeDepsWork(logPath, readyOffset)).not.toThrow();
    expect(fullRead).not.toHaveBeenCalled();

    fs.appendFileSync(logPath, "post-ready pnpm install should fail\n", "utf8");

    expect(() => runtimeSmoke.assertNoPostReadyRuntimeDepsWork(logPath, readyOffset)).toThrow(
      /post-ready runtime dependency work/u,
    );
  });

  registerRuntimeCommandOutputTimeoutTest();

  it("cleans per-call RPC state directories", async () => {
    const root = makePackageRoot();
    const statePath = path.join(root, "rpc-state.txt");
    const entrypoint = path.join(root, "dist", "rpc-entry.js");
    writeSource(entrypoint, [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.OPENCLAW_TEST_RPC_STATE_PATH, process.env.OPENCLAW_STATE_DIR);",
      "console.log(JSON.stringify({ ok: true, result: { status: 'ok' } }, null, 2));",
      "console.log(JSON.stringify({ level: 'warn', message: 'post-rpc diagnostic' }));",
      "",
    ]);

    await expect(
      runtimeSmoke.rpcCall(
        "health",
        {},
        {
          entrypoint,
          env: { OPENCLAW_TEST_RPC_STATE_PATH: statePath },
          port: 19001,
        },
      ),
    ).resolves.toEqual({ status: "ok" });

    const rpcStateDir = fs.readFileSync(statePath, "utf8");
    expect(path.basename(rpcStateDir)).toMatch(/^openclaw-plugin-runtime-rpc-/u);
    expect(fs.existsSync(rpcStateDir)).toBe(false);
  });

  it("accepts successful runtime HTTP probes", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    await withServer(server, async (port) => {
      await expect(runtimeSmoke.httpOk(port, "/healthz", { timeoutMs: 1000 })).resolves.toBe(true);
    });
  });

  it.each([
    {
      name: "allows degraded runtime readiness only for expected channel failures",
      status: 503,
      body: '{"ready":false,"failing":["qa-channel"]}',
    },
    {
      name: "rejects degraded runtime readiness for unexpected channel failures",
      status: 503,
      body: '{"ready":false,"failing":["unexpected"]}',
      error: '/readyz returned HTTP 503: {"ready":false,"failing":["unexpected"]}',
    },
    {
      name: "rejects generic readyz server errors in degraded runtime mode",
      status: 500,
      body: '{"ready":true}',
      error: '/readyz returned HTTP 500: {"ready":true}',
    },
    {
      name: "keeps readyz HTTP status diagnostics when the body is malformed",
      status: 503,
      body: "not json",
      error: '/readyz returned HTTP 503: "not json"',
    },
    {
      name: "bounds readyz diagnostic response bodies",
      status: 503,
      body: "",
      contentLength: 1024 * 1024 + 1,
      error: "/readyz probe response body exceeded 1048576 bytes",
    },
  ])("$name", async ({ status, body, error, contentLength }) => {
    runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "100",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS: "50",
    });
    const server = createHttpServer((_request, response) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
      });
      response.end(body);
    });
    await withServer(server, async (port) => {
      const probe = runtimeSmoke.assertReadyzProbe({
        allowedDegradedReadyzFailures: ["qa-channel"],
        pluginId: "qa-channel",
        port,
      });
      if (error) {
        await expect(probe).rejects.toThrow(error);
      } else {
        await expect(probe).resolves.toBeUndefined();
      }
    });
  });

  it("bounds stalled runtime HTTP probes", async () => {
    await withStalledServer(async (port) => {
      const startedAt = Date.now();

      await expect(runtimeSmoke.httpOk(port, "/healthz", { timeoutMs: 100 })).resolves.toBe(false);

      expect(Date.now() - startedAt).toBeLessThan(2_500);
    });
  });

  it("keeps stalled runtime readiness probes inside the ready deadline", async () => {
    runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "1000",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS: "50",
    });
    const logPath = logFixture("booting\n");

    await withStalledServer(async (port) => {
      const startedAt = Date.now();

      await expect(
        runtimeSmoke.waitForReady({
          child: { exitCode: null, signalCode: null },
          logPath,
          port,
        }),
      ).rejects.toThrow("gateway did not become ready");

      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });

  it("creates runtime smoke state with OPENCLAW_HOME at the test home", async () => {
    const env = runtimeSmoke.createIsolatedStateEnv("runtime-env");

    expect(env).toMatchObject({
      USERPROFILE: env.HOME,
      OPENCLAW_HOME: env.HOME,
      OPENCLAW_STATE_DIR: path.join(env.HOME, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
    });
    expect(fs.existsSync(path.dirname(env.HOME))).toBe(true);

    runtimeSmoke.cleanupIsolatedStateEnv(env);

    expect(fs.existsSync(path.dirname(env.HOME))).toBe(false);
  });

  it("selects packaged plugins when list output includes structured diagnostics", () => {
    const { root, entries } = pluginFixture(
      [
        {
          id: "admin-http-rpc",
          directory: "dist-runtime/extensions/admin-http-rpc",
          configSchema: { required: ["port"] },
        },
      ],
      true,
    );
    const pluginRoot = entries[0]!.rootDir;

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`admin-http-rpc\tadmin-http-rpc\t1\t${pluginRoot}`);
  });

  it("does not select source-only bundled plugins for package-backed sweeps", () => {
    const { root } = pluginFixture([
      { id: "qa-channel", directory: "extensions/qa-channel" },
      { id: "clickclack", directory: "dist-runtime/extensions/clickclack" },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: "qa-channel",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS entry is not an installable bundled plugin in this package: qa-channel",
    );
    expect(result.stderr).toContain("Available: clickclack");
  });

  it("rejects loose packaged plugin list limit env values", () => {
    const root = makePackageRoot();

    const timeout = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: "100ms",
    });
    expect(timeout.status).toBe(1);
    expect(timeout.stderr).toContain("invalid OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: 100ms");

    const maxBuffer = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES: "64bytes",
    });
    expect(maxBuffer.status).toBe(1);
    expect(maxBuffer.stderr).toContain(
      "invalid OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES: 64bytes",
    );
  });

  it("bounds plugin list selection when the CLI hangs", () => {
    const root = makePackageRoot();
    fs.writeFileSync(
      path.join(root, "dist", "index.js"),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
      "utf8",
    );

    const startedAt = Date.now();
    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: "100",
    });

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Timed out listing packaged bundled plugins after 100ms");
  });

  it("loads runtime smoke manifests from the selected packaged root", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist/extensions/runtime-only", {
      id: "runtime-only",
      contracts: { speechProviders: ["stale-provider"] },
    });
    fs.mkdirSync(path.join(root, "dist-runtime", "extensions", "runtime-only"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "dist-runtime", "extensions", "runtime-only", "openclaw.plugin.json"),
      '{"id":"runtime-only"}\n',
      "utf8",
    );

    const result = runRuntimeSmoke(root, [
      "tts-global-disable",
      "runtime-only",
      "runtime-only",
      "0",
      "0",
      path.join(root, "dist-runtime", "extensions", "runtime-only"),
      "",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Global-disable TTS smoke skipped for runtime-only: no speech provider contract",
    );
  });

  it("accepts native Windows bundled source paths when asserting install state", () => {
    const root = makePackageRoot();
    const windowsSourcePath = "C:\\crabbox\\qa-windows\\dist\\extensions\\nostr";
    const stateDir = writeInstalledPlugin(root, windowsSourcePath);

    const result = runStateProbe(root, stateDir, ["assert-installed", "nostr", "nostr", "0"]);

    expect(result.status).toBe(0);
  });

  it.each([
    { defect: "mismatched root", error: "did not match selected root" },
    { defect: "missing root", error: "does not exist" },
  ])("rejects a bundled install source with a $defect", ({ defect, error }) => {
    const root = makePackageRoot();
    const selectedRoot = path.join(root, "dist-runtime", "extensions", "nostr");
    const staleRoot = path.join(root, "dist-runtime", "extensions", "nostr-copy");
    if (defect === "mismatched root") {
      fs.mkdirSync(selectedRoot, { recursive: true });
      fs.mkdirSync(staleRoot, { recursive: true });
    }
    const stateDir = writeInstalledPlugin(
      root,
      defect === "mismatched root" ? staleRoot : selectedRoot,
    );

    const result = runStateProbe(root, stateDir, [
      "assert-installed",
      "nostr",
      "nostr",
      "0",
      selectedRoot,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it("detects native Windows bundled load paths after uninstall", () => {
    const root = makePackageRoot();
    const stateDir = writePluginState(root, {
      plugins: { load: { paths: ["C:\\crabbox\\qa-windows\\dist\\extensions\\nostr"] } },
    });
    const result = runStateProbe(root, stateDir, ["assert-uninstalled", "nostr", "nostr"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("load path still present after uninstall for nostr");
  });
});
