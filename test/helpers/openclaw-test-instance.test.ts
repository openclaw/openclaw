import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { hasErrnoCode } from "../../src/infra/errno.js";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "../../src/plugin-sdk/file-lock.js";
import { resolveMaxOutputBytes } from "../../src/process/exec-output.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  GatewayStartupRefusedError,
  type GatewayReadinessDiagnostic,
  type OpenClawTestInstance,
  testing,
} from "./openclaw-test-instance.js";
import { isProcessAlive, waitForDead } from "./process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";
import { runNodeScript } from "./run-node-script.js";

const WRITER_CLEANUP_HANG_GUARD_MS = 5_000;
const MIGRATION_CONVERGENCE_REFUSAL =
  "OpenClaw plugin migration inputs changed during startup convergence;";
const RESTART_MARKER =
  "[openclaw-test-instance] restarting gateway after migration convergence refusal";
const LEGACY_STORE_PATH = "/fixture/sessions/sessions.json";
const LEGACY_MIGRATION_REFUSAL = `Legacy session store requires migration: ${LEGACY_STORE_PATH}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`;
const PROFILED_LEGACY_MIGRATION_REFUSAL = `Legacy session store requires migration: ${LEGACY_STORE_PATH}. Run "openclaw --profile qa-fixture doctor --fix" against the same state/config before starting OpenClaw.`;
const LEGACY_STARTUP_FAILURE = [
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
  `- Legacy sessions store unreadable; left in place at ${LEGACY_STORE_PATH}`,
  '- Migration step "agent-dir" was not run because prior step "sessions" refused execution.',
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
].join("\n");
const CONTROL_REQUEST_SOURCE = `
import { get as getControl } from "node:http";
function waitForControl(url) {
  return new Promise((resolve, reject) => {
    getControl(url, { agent: false }, (response) => {
      response.once("error", reject);
      response.once("end", resolve);
      response.resume();
    }).once("error", reject);
  });
}
`;
const fakeInstances: {
  instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
  writerPidPath?: string;
}[] = [];
const fakeRoots: string[] = [];
const fakeOperations: Promise<unknown>[] = [];
const fakeControls: FakeGatewayControl[] = [];

type FakeGatewayControl = {
  url: string;
  reached: Promise<void>;
  launches: number[];
  parents: number[];
  observers: { beforeRelease: () => void; onLaunch: () => void };
  unblock: () => void;
  release: () => Promise<void>;
  close: () => Promise<void>;
};

type FakeGatewayAttempt = {
  argv: string[];
  config: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  pid: number;
  port: number;
};

afterEach(async () => {
  const controls = fakeControls.splice(0);
  for (const control of controls) {
    control.unblock();
  }
  await Promise.allSettled(fakeOperations.splice(0));
  const results = await Promise.allSettled(
    fakeInstances.splice(0).map(async (owner) => {
      const { instance, writerPidPath } = owner;
      // Baseline failures can spawn after cleanup has already marked itself done.
      try {
        await runQaGatewayFixture(
          () => instance.stopGateway(),
          async () => {
            if (writerPidPath) {
              const pid = Number(await fs.readFile(writerPidPath, "utf8"));
              expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
              // Cleanup hang guard after the owner released the writer, not a readiness race.
              await waitForDead(pid, AbortSignal.timeout(WRITER_CLEANUP_HANG_GUARD_MS));
            }
          },
        );
        await instance.cleanup();
      } catch (error) {
        fakeInstances.push(owner);
        throw error;
      }
    }),
  );
  const controlResults = await Promise.allSettled(
    controls.map(async (control) => {
      try {
        await control.close();
      } catch (error) {
        fakeControls.push(control);
        throw error;
      }
    }),
  );
  const failures = [...results, ...controlResults].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "fake Gateway cleanup failed; owners and roots retained");
  }
  await Promise.all(fakeRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

function trackOperation<T>(operation: Promise<T>): Promise<T> {
  fakeOperations.push(operation.catch(() => undefined));
  return operation;
}

async function observeCliExit() {
  const managed = await import("../../scripts/lib/managed-child-process.mts");
  const run = managed.runManagedCommand;
  const exited = createDeferred();
  // Observe the existing process handoff without replacing spawning or pipe ownership.
  const observer = vi.spyOn(managed, "runManagedCommand").mockImplementation((options) =>
    run({
      ...options,
      onReady(child) {
        child.once("exit", () => exited.resolve());
        options.onReady?.(child);
      },
    }),
  );
  return { exited: exited.promise, restore: () => observer.mockRestore() };
}

async function listen(server: net.Server, port = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function observeGatewayExit(control: FakeGatewayControl, instance: OpenClawTestInstance) {
  const exited = createDeferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
    at: number;
  }>();
  control.observers.onLaunch = () => {
    if (control.launches.length !== 1) {
      return;
    }
    const leader = instance.child;
    if (!leader) {
      exited.reject(new Error("fixture launched without a process owner"));
      return;
    }
    leader.once("exit", (code, signal) => exited.resolve({ code, signal, at: Date.now() }));
  };
  return exited.promise;
}

async function expectReady(instance: OpenClawTestInstance) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
  expect(await response.json()).toEqual({ ready: true });
}

const readyReceipt = {
  outcome: "ready",
  lastProbe: { phase: "complete", status: 200, ready: true },
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function createGatewayControl(): Promise<FakeGatewayControl> {
  const reached = createDeferred();
  const released = createDeferred();
  const launches: number[] = [];
  const parents: number[] = [];
  const observers = { beforeRelease: () => {}, onLaunch: () => {} };
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/wait") {
      reached.resolve();
      void released.promise.then(() => response.end("released"));
      return;
    }
    if (url.pathname === "/release") {
      observers.beforeRelease();
      released.resolve();
    } else if (url.pathname === "/launch") {
      launches.push(Number(url.searchParams.get("pid")));
      parents.push(Number(url.searchParams.get("parent")));
      observers.onLaunch();
    }
    response.end("ok");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("control server has no port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const control = {
    url,
    reached: reached.promise,
    launches,
    parents,
    observers,
    unblock: () => released.resolve(),
    release: async () => {
      const response = await fetch(`${url}/release`);
      await response.text();
    },
    close: async () => {
      released.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
  fakeControls.push(control);
  return control;
}

async function createFakeGateway(
  sequence: string,
  {
    startTimeoutMs = 1_000,
    stopTimeoutMs = 1_500,
    control,
    ...ownerOptions
  }: {
    startTimeoutMs?: number;
    stopTimeoutMs?: number;
    control?: { url: string; holdPreparation?: boolean };
    signal?: AbortSignal;
    verifyCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
  } = {},
) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "openclaw-test-instance-gateway-"));
  fakeRoots.push(cwd);
  const distDir = path.join(cwd, "dist");
  const tracePath = path.join(cwd, "attempts.jsonl");
  // Diagnostic runs keep these receipts outside Vitest's disposable temp tree.
  const processReceipt = `
const registry = ${JSON.stringify(process.env.OPENCLAW_HELPER_PROOF_PID_REGISTRY ?? null)};
function recordFixtureProcess(pid) {
  if (!registry) return;
  let identity;
  try {
    identity = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 1_000 }).trim();
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
  appendFileSync(registry, JSON.stringify({ pid, cwd: process.cwd(), identity }) + "\\n");
}
recordFixtureProcess(process.pid);
`;
  await fs.mkdir(distDir);
  await Promise.all([
    ...(control?.holdPreparation
      ? []
      : [
          fs.writeFile(path.join(distDir, ".buildstamp"), ""),
          fs.writeFile(path.join(distDir, ".runtime-postbuildstamp"), ""),
        ]),
    fs.writeFile(
      path.join(distDir, "index.mjs"),
      `
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
${CONTROL_REQUEST_SOURCE}
${processReceipt}
const tracePath = process.env.OPENCLAW_FAKE_GATEWAY_TRACE;
const controlUrl = process.env.OPENCLAW_FAKE_GATEWAY_CONTROL;
function spawnInheritedWriter(stream, output) {
  // Windows must keep the writer alive after its leader exits; the HTTP gate owns release.
  const delayed = spawn(process.execPath, ["-e", 'require("node:http").get(process.argv[1] + "/wait", (response) => { response.resume(); response.on("end", () => process[process.argv[2]].write(process.argv[3], () => process.exit(0))); });', controlUrl, stream, output], { detached: process.platform === "win32", stdio: ["ignore", stream === "stdout" ? "inherit" : "ignore", stream === "stderr" ? "inherit" : "ignore"] });
  recordFixtureProcess(delayed.pid);
  writeFileSync(tracePath + ".writer-pid", String(delayed.pid));
}
if (controlUrl) await waitForControl(controlUrl + "/launch?pid=" + process.pid + "&parent=" + process.ppid);
const countPath = tracePath + ".count";
let attempt = 1;
try { attempt = Number(readFileSync(countPath, "utf8")) + 1; } catch {}
writeFileSync(countPath, String(attempt));
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const env = Object.fromEntries(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_STATE_DIR"].map((key) => [key, process.env[key]]));
appendFileSync(tracePath, JSON.stringify({ argv, config: JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), cwd: process.cwd(), env, pid: process.pid, port }) + "\\n");
const kind = (process.env.OPENCLAW_FAKE_GATEWAY_SEQUENCE || "ready").split(",")[attempt - 1] || "ready";
if (kind === "cli-json") {
  if (argv[1] === "overflow-close") {
    const splitCodePoint = Buffer.from([0xf0, 0x9f, 0xa6, 0x8a]);
    const first = Buffer.concat([
      Buffer.alloc(Number(argv[0]) - 2, 0x61),
      splitCodePoint.subarray(0, 2),
    ]);
    await new Promise((resolve) => process.stdout.write(first, resolve));
    await waitForControl(controlUrl + "/wait");
    await new Promise((resolve) =>
      process.stdout.end(
        Buffer.concat([
          splitCodePoint.subarray(2),
          Buffer.from("\\ntrailing overflow output\\n"),
        ]),
        resolve,
      ),
    );
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const json = JSON.stringify({ first: "complete", payload: "é".repeat(Number(argv[0])), providerCredentialPresent: Object.hasOwn(process.env, "OPENAI_API_KEY"), last: "complete" });
  await Promise.all([
    new Promise((resolve) => process.stdout.write(json, resolve)),
    new Promise((resolve) => process.stderr.write("discarded diagnostic " + "x".repeat(300 * 1024) + "\\nrecent cli diagnostic\\n", resolve)),
  ]);
  // Keep the overflow producer alive so cancellation owns a live process.
  if (argv[1] === "overflow") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}
process.stdout.write("fake gateway attempt " + attempt + "\\n");
if (kind === "cli" || kind === "cli-drain") {
  process.stderr.write("cli diagnostic\\n");
  if (argv[0] === "wait") {
    setInterval(() => {}, 1_000);
    if (controlUrl) await waitForControl(controlUrl + "/wait");
    await new Promise(() => {});
  }
  if (kind === "cli-drain") {
    spawnInheritedWriter("stdout", "drained cli output\\n");
    process.exit(0);
  }
  process.exit(Number(argv[0]));
}
const refusal = ${JSON.stringify(MIGRATION_CONVERGENCE_REFUSAL)};
const legacyRefusal = kind.startsWith("startup-") ? ${JSON.stringify(LEGACY_STARTUP_FAILURE)} : kind.startsWith("profile-") ? ${JSON.stringify(PROFILED_LEGACY_MIGRATION_REFUSAL)} : ${JSON.stringify(LEGACY_MIGRATION_REFUSAL)};
if (kind === "legacy-refuse" || kind === "startup-legacy-refuse" || kind === "profile-legacy-refuse") { process.stderr.write(legacyRefusal + "\\n"); process.exit(78); }
if (kind === "late-legacy-refuse" || kind === "startup-late-legacy-refuse") {
  spawnInheritedWriter("stderr", legacyRefusal + "\\n");
  process.exit(78);
}
if (kind === "legacy-stdout") { process.stdout.write(legacyRefusal + "\\n"); process.exit(78); }
if (kind === "legacy-status1") { process.stderr.write(legacyRefusal + "\\n"); process.exit(1); }
if (kind === "legacy-no-advice") { process.stderr.write("Legacy session store requires migration: " + ${JSON.stringify(LEGACY_STORE_PATH)} + "\\n"); process.exit(78); }
if (kind === "startup-no-advice") { process.stderr.write(legacyRefusal.split("\\n").slice(0, -1).join("\\n") + "\\n"); process.exit(78); }
if (kind === "startup-warning") { process.stderr.write(legacyRefusal.split("\\n").slice(1).join("\\n") + "\\n"); process.exit(78); }
if (kind === "config-refuse") { process.stderr.write("unrelated configuration failure\\n"); process.exit(78); }
if (kind === "refuse") { process.stderr.write("notice\\n" + refusal + " fixture\\n"); process.exit(1); }
if (kind === "late-refuse") {
  spawnInheritedWriter("stderr", refusal + " delayed fixture\\n");
  process.exit(1);
}
if (kind === "terminal-drain" || kind === "refusal-drain") {
  const draining = spawn(process.execPath, ["-e", 'const fs = require("node:fs");const release = process.argv[1];const deadline = Date.now() + 5_000;const timer = setInterval(() => { if (fs.existsSync(release) || Date.now() >= deadline) clearInterval(timer); }, 10);', tracePath + ".draining-release"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  draining.unref();
  recordFixtureProcess(draining.pid);
  writeFileSync(tracePath + ".draining-pid", String(draining.pid));
  process.stderr.write(kind === "refusal-drain" ? refusal + " held fixture\\n" : "terminal startup failure\\n"); process.exit(kind === "refusal-drain" ? 1 : 7);
}
if (kind === "near") { process.stderr.write(refusal.slice(0, -1) + " fixture\\n"); process.exit(1); }
if (kind === "prefixed") { process.stderr.write("prefix " + refusal + " fixture\\n"); process.exit(1); }
if (kind === "stdout") { process.stdout.write(refusal + " fixture\\n"); process.exit(1); }
if (kind === "status2") { process.stderr.write(refusal + " fixture\\n"); process.exit(2); }
if (kind === "signal") { process.stderr.write(refusal + " fixture\\n"); process.kill(process.pid, "SIGTERM"); }
if (kind === "late-unrelated") {
  spawnInheritedWriter("stderr", "unrelated startup failure\\n");
  process.exit(1);
}
if (kind === "held-unrelated") await waitForControl(controlUrl + "/wait");
if (kind === "unrelated" || kind === "held-unrelated") { process.stderr.write("unrelated startup failure\\n"); process.exit(1); }
if (kind === "detached-stopped") {
  const escaped = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1_000);process.send("ready");'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((resolve) => escaped.once("message", resolve));
  process.kill(escaped.pid, "SIGSTOP");
  writeFileSync(tracePath + ".escaped-pid", String(escaped.pid));
  escaped.disconnect();
  escaped.unref();
}
const server = createServer(async (req, res) => {
  if (req.url === "/startupz") {
    if (kind === "held-ready") await waitForControl(controlUrl + "/wait");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "started" }));
    return;
  }
  res.writeHead(req.url === "/readyz" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ready: req.url === "/readyz" && kind !== "never-ready" }));
});
process.on("SIGTERM", () => { if (kind !== "detached-stopped") server.close(() => process.exit(0)); }); server.listen(port, "127.0.0.1");
`,
    ),
  ]);
  if (control?.holdPreparation) {
    await fs.mkdir(path.join(cwd, "scripts"));
    // This is a fixture bootstrap, not the repository's build entrypoint.
    await fs.writeFile(
      path.join(cwd, "scripts", "run-node.mjs"),
      `import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
${CONTROL_REQUEST_SOURCE}
${processReceipt}
await waitForControl(${JSON.stringify(`${control.url}/wait`)});
writeFileSync("dist/.buildstamp", "");
writeFileSync("dist/.runtime-postbuildstamp", "");
`,
    );
  }
  const instance = await createOpenClawTestInstance({
    name: `fake-gateway-${path.basename(cwd)}`,
    cwd,
    env: {
      OPENCLAW_FAKE_GATEWAY_SEQUENCE: sequence,
      OPENCLAW_FAKE_GATEWAY_TRACE: tracePath,
      OPENCLAW_FAKE_GATEWAY_CONTROL: control?.url,
    },
    startTimeoutMs,
    stopTimeoutMs,
    ...ownerOptions,
  });
  fakeInstances.push({
    instance,
    // Join inherited writers after releasing their HTTP gate, including failed commands/startup.
    writerPidPath: sequence
      .split(",")
      .some(
        (kind) =>
          kind === "late-unrelated" ||
          kind === "late-refuse" ||
          kind === "late-legacy-refuse" ||
          kind === "startup-late-legacy-refuse" ||
          kind === "cli-drain",
      )
      ? `${tracePath}.writer-pid`
      : undefined,
  });
  return {
    instance,
    tracePath,
    readAttempts: async (): Promise<FakeGatewayAttempt[]> =>
      (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeGatewayAttempt),
  };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function isPortReserved(port: number): Promise<boolean> {
  const competitor = net.createServer();
  try {
    await listen(competitor, port);
    return false;
  } catch (error) {
    if (!hasErrnoCode(error, "EADDRINUSE")) {
      throw error;
    }
    return true;
  } finally {
    await closeServer(competitor);
  }
}

// Freeze policy time without replacing real HTTP, child events, or teardown.
function freezePolicyClock(signal: AbortSignal) {
  signal.throwIfAborted();
  const now = Date.now.bind(Date);
  const fixtureTime = now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(fixtureTime);
  const restoreClock = () => {
    clock.mockRestore();
    signal.removeEventListener("abort", restoreClock);
  };
  signal.addEventListener("abort", restoreClock, { once: true });
  return { clock, now, fixtureTime, restoreClock };
}

async function startGatewayForPortLifecycle(
  instance: OpenClawTestInstance,
  signal: AbortSignal,
): Promise<void> {
  const { restoreClock } = freezePolicyClock(signal);
  try {
    await trackOperation(instance.startGateway());
  } finally {
    restoreClock();
  }
}

function createGatewayProcessState(
  overrides: Partial<{
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }> = {},
) {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    ...overrides,
  });
}

function waitForReady(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  {
    processState = createGatewayProcessState(),
    signal,
    record,
  }: {
    processState?: ReturnType<typeof createGatewayProcessState>;
    signal?: AbortSignal;
    record?: (diagnostic: GatewayReadinessDiagnostic) => void;
  } = {},
) {
  return testing.waitForGatewayReady(
    processState,
    [],
    [],
    12345,
    timeoutMs,
    fetchImpl,
    signal,
    record,
  );
}

function readReadinessReceipt(error: unknown) {
  if (!(error instanceof Error)) {
    throw new Error("expected a readiness failure", { cause: error });
  }
  const prefix = "[openclaw-test-instance] readiness ";
  const lines = error.message.split("\n").filter((line) => line.startsWith(prefix));
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1_024);
  return JSON.parse(line.slice(prefix.length));
}

function createStalledReadinessFetch(phase: "headers" | "body") {
  return vi.fn<typeof fetch>((_url, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("readiness probe signal is required");
    }
    const stalled = (async (): Promise<never> => {
      for (;;) {
        signal.throwIfAborted();
        await once(signal, "abort");
      }
    })();
    if (phase === "headers") {
      return stalled;
    }
    const response = new Response(null, { status: 503 });
    response.json = () => stalled;
    return Promise.resolve(response);
  });
}

describe("openclaw test instance", () => {
  it("reserves its idle port through refusal, CLI work, and stopped restarts", async ({
    signal,
  }) => {
    const { instance, readAttempts } = await createFakeGateway("unrelated,cli,ready,ready");
    const reserved = {
      created: await isPortReserved(instance.port),
      refused: false,
      stopped: false,
    };
    await expect(startGatewayForPortLifecycle(instance, signal)).rejects.toThrow(
      "unrelated startup failure",
    );
    expect(instance.readiness).toMatchObject([
      { outcome: "child-exit", child: { exitCode: 1, signalCode: null } },
    ]);
    expect(instance.child).toBeUndefined();
    reserved.refused = await isPortReserved(instance.port);
    await expect(instance.cli(["0"])).resolves.toMatchObject({ code: 0, signal: null });
    await startGatewayForPortLifecycle(instance, signal);
    expect(instance.readiness).toMatchObject([readyReceipt]);
    await instance.stopGateway();
    reserved.stopped = await isPortReserved(instance.port);
    await startGatewayForPortLifecycle(instance, signal);
    expect(instance.readiness).toMatchObject([readyReceipt]);
    const attempts = await readAttempts();
    expect(attempts).toHaveLength(4);
    expect(
      attempts.filter((attempt) => attempt.argv[0] === "gateway").map((attempt) => attempt.port),
    ).toEqual([instance.port, instance.port, instance.port]);
    const child = instance.child;
    expect(child).toBeDefined();
    const serverSpy = vi.spyOn(net, "createServer");
    try {
      await instance.cleanup();
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      expect(child?.stdout.closed).toBe(true);
      expect(child?.stderr.closed).toBe(true);
      await instance.cleanup();
      await instance.stopGateway();
      // Terminal calls must not leave a new idle reservation behind.
      for (const result of serverSpy.mock.results) {
        if (result.type === "return") {
          expect(result.value.listening).toBe(false);
        }
      }
    } finally {
      serverSpy.mockRestore();
    }
    await expectPathMissing(instance.state.root);
    expect(reserved).toEqual({ created: true, refused: true, stopped: true });
  });

  it("releases reservation probe connections before startup and terminal cleanup", async ({
    signal,
  }) => {
    const { instance } = await createFakeGateway("ready");
    const serverSpy = vi.spyOn(net, "createServer");
    const probe = net.connect(instance.port, "127.0.0.1");
    try {
      await withinTest(once(probe, "close"), signal);
      await startGatewayForPortLifecycle(instance, signal);
      expect(instance.readiness).toMatchObject([readyReceipt]);
      await instance.stopGateway();
      const reservation = serverSpy.mock.results.find(
        (result) => result.type === "return" && result.value.listening,
      )?.value;
      expect(reservation?.listening).toBe(true);
      const closed = vi.fn();
      reservation?.once("close", closed);
      await instance.cleanup();
      expect(closed).toHaveBeenCalledOnce();
      expect(reservation?.listening).toBe(false);
      expect(reservation?.address()).toBeNull();
    } finally {
      probe.destroy();
      serverSpy.mockRestore();
    }
  });

  it.for(["held-unrelated", "late-unrelated"])(
    "preserves the refusal when reacquiring the same port fails (%s)",
    async (action, { signal }) => {
      const control = await createGatewayControl();
      const { instance } = await createFakeGateway(action, { control, signal });
      const exited = observeGatewayExit(control, instance);
      const competitor = net.createServer((socket) => socket.destroy());
      const startup = startGatewayForPortLifecycle(instance, signal);
      const outcome = startup.catch((error: unknown) => error);
      try {
        await Promise.race([control.reached, startup]);
        await listen(competitor, instance.port);
        if (action === "late-unrelated") {
          await Promise.race([exited, outcome]);
          expect(instance.child?.stderr.closed).toBe(false);
          expect(instance.logs()).not.toContain("unrelated startup failure");
        }
        await control.release();
        const error = await outcome;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          expect.objectContaining({
            message: expect.stringContaining("unrelated startup failure"),
          }),
          expect.objectContaining({ code: "EADDRINUSE" }),
        ]);
        expect(instance.child).toBeUndefined();
        await instance.cleanup();
        await instance.stopGateway();
        expect(competitor.listening).toBe(true);
        await expectPathMissing(instance.state.root);
      } finally {
        control.unblock();
        await outcome;
        await closeServer(competitor);
      }
    },
  );

  it("leaves explicitly supplied ports owned by the caller", async () => {
    const caller = net.createServer();
    const closed = vi.fn();
    caller.on("close", closed);
    await listen(caller);
    const address = caller.address();
    if (!address || typeof address === "string") {
      throw new Error("caller has no port");
    }
    try {
      const instance = await createOpenClawTestInstance({
        name: "caller-owned-port",
        port: address.port,
      });
      fakeInstances.push({ instance });
      await instance.stopGateway();
      await instance.cleanup();
      expect(caller.listening).toBe(true);
      expect(closed).not.toHaveBeenCalled();
      await expect(isPortReserved(address.port)).resolves.toBe(true);
    } finally {
      await closeServer(caller);
    }
    expect(closed).toHaveBeenCalledOnce();
    expect(caller.listening).toBe(false);
    expect(caller.address()).toBeNull();
  });

  it.for(["complete", "overflow", "overflow-close"] as const)(
    "owns complete CLI JSON and diagnostic tails (%s)",
    async (mode, { signal }) => {
      await withEnvAsync({ OPENAI_API_KEY: "ambient-provider-fixture" }, async () => {
        const control = mode === "overflow-close" ? await createGatewayControl() : undefined;
        const { instance, tracePath, readAttempts } = await createFakeGateway("cli-json", {
          control,
        });
        // The command must not merge a removed credential back from its parent.
        delete instance.env.OPENAI_API_KEY;
        const characters =
          mode === "complete"
            ? 160 * 1024
            : mode === "overflow-close"
              ? resolveMaxOutputBytes(undefined, "stdout")
              : resolveMaxOutputBytes(undefined, "stdout") / 2;
        const command = trackOperation(instance.cli([String(characters), mode]));
        if (mode !== "complete") {
          const outcomePromise = command.then(
            (result) => ({
              code: result.code,
              stdoutBytes: Buffer.byteLength(result.stdout),
            }),
            (error: unknown) => error,
          );
          if (mode === "overflow-close") {
            try {
              // The fixture requests release only after its first stdout write completes.
              await withinTest(
                awaitGateBeforeSettlement(
                  control!.reached,
                  command,
                  `timeout waiting for ${tracePath}.overflow-ready`,
                ),
                signal,
              );
            } finally {
              control!.unblock();
              await Promise.allSettled([command]);
            }
          }
          const outcome = await outcomePromise;
          if (!(outcome instanceof Error)) {
            throw new Error(`Expected command output overflow failure: ${JSON.stringify(outcome)}`);
          }
          expect(outcome.message).toContain("command stdout exceeded capture limit");
          if (mode === "overflow") {
            expect(outcome.message).toContain('"last":"complete"');
          } else {
            expect(outcome.message).toContain(String.fromCodePoint(0x1f98a));
            expect(outcome.message).toContain("trailing overflow output");
            expect(outcome.message).not.toContain("\uFFFD");
          }
          expect(Buffer.byteLength(outcome.message)).toBeLessThan(600 * 1024);
        } else {
          const result = await command;
          expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
          expect(JSON.parse(result.stdout)).toEqual({
            first: "complete",
            payload: "é".repeat(characters),
            providerCredentialPresent: false,
            last: "complete",
          });
          expect(result.stderr).toContain("[output truncated to last");
          expect(result.stderr).toContain("recent cli diagnostic");
          expect(result.stderr).not.toContain("discarded diagnostic");
          expect(Buffer.byteLength(result.stderr)).toBeLessThan(300 * 1024);
        }
        const attempts = await readAttempts();
        expect(attempts).toHaveLength(1);
        expect(isProcessAlive(attempts[0]!.pid)).toBe(false);
      });
    },
  );

  it.for([
    { mode: "7", code: 7, signal: null },
    ...(process.platform === "win32" ? [] : [{ mode: "signal", code: null, signal: "SIGTERM" }]),
    { mode: "wait", code: null, signal: null },
  ])("reports CLI exit or timeout for $mode", async ({ mode, code, signal }) => {
    const { instance, readAttempts } = await createFakeGateway(mode === "signal" ? mode : "cli");
    const command = trackOperation(
      instance.cli([mode], { timeoutMs: mode === "wait" ? 1_000 : 30_000 }),
    );
    if (mode === "wait") {
      await expect(command).rejects.toThrow("command timed out after 1000ms");
    } else {
      await expect(command).resolves.toMatchObject({ code, signal });
    }
    const [attempt] = await readAttempts();
    expect(isProcessAlive(attempt!.pid)).toBe(false);
  });

  it("captures CLI output written after leader exit", async ({ signal }) => {
    const control = await createGatewayControl();
    const { instance } = await createFakeGateway("cli-drain", { control });
    const observed = await observeCliExit();
    const command = trackOperation(instance.cli(["drain"]));
    try {
      await withinTest(
        awaitGateBeforeSettlement(control.reached, command, "writer did not start"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(observed.exited, command, "leader did not exit"),
        signal,
      );
      await control.release();
      await expect(command).resolves.toEqual({
        code: 0,
        signal: null,
        stdout: "fake gateway attempt 1\ndrained cli output\n",
        stderr: "cli diagnostic\n",
      });
    } finally {
      observed.restore();
      control.unblock();
      await Promise.allSettled([command]);
    }
  });

  it.for([0, 1])(
    "keeps claimed port offset %i unavailable while its child starts",
    async (offset, { signal }) => {
      const control = await createGatewayControl();
      const { instance } = await createFakeGateway("held-unrelated", {
        startTimeoutMs: 10_000,
        control,
        signal,
      });
      const starting = startGatewayForPortLifecycle(instance, signal);
      await Promise.race([control.reached, starting]);
      await drainFileLockStateForTest();
      resetFileLockStateForTest();
      const script = `
      import { mock } from "node:test";
      import { realpath } from "node:fs/promises";
      import { tmpdir } from "node:os";
      const ports = await import(${JSON.stringify(new URL("../../src/test-utils/ports.ts", import.meta.url).href)});
      const attempted = [];
      const candidates = ${JSON.stringify([instance.port + offset, instance.port + (1 - offset)])};
      mock.module(${JSON.stringify(new URL("../../src/test-utils/ports.ts", import.meta.url).href)}, {
        namedExports: { ...ports, getDeterministicFreePortBlock: async (options) => {
          let candidate = candidates.shift() ?? await ports.getDeterministicFreePortBlock(options);
          while (attempted.includes(candidate)) candidate = await ports.getDeterministicFreePortBlock(options);
          attempted.push(candidate);
          return candidate;
        } },
      });
      const { acquireTestPortBlock } = await import(${JSON.stringify(new URL("../../src/test-utils/port-claims.ts", import.meta.url).href)});
      const claim = await acquireTestPortBlock({ offsets: [0, 1] });
      try { console.log(JSON.stringify({ pid: process.pid, port: claim.port, attempted, tempRoot: await realpath(tmpdir()) })); }
      finally { await claim.release(); }
    `;
      const contenderRoot = await fs.mkdtemp(path.join(tmpdir(), "port-contender-"));
      fakeRoots.push(contenderRoot);
      const allocateContender = async () => {
        const result = await runNodeScript(
          [
            "--experimental-test-module-mocks",
            "--import",
            new URL("../../scripts/tsx.mjs", import.meta.url).href,
            "--input-type=module",
            "-e",
            script,
          ],
          { ...process.env, TMPDIR: contenderRoot, TMP: contenderRoot, TEMP: contenderRoot },
          20_000,
          { cwd: process.cwd(), requireProcessTreeExit: true },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout.trim());
      };
      try {
        const contender = await allocateContender();
        expect(contender.tempRoot).not.toBe(await fs.realpath(tmpdir()));
        expect(contender.pid).not.toBe(process.pid);
        expect([instance.port, instance.port + 1]).not.toContain(contender.port);
        expect(contender.attempted.slice(0, 2)).toEqual([
          instance.port + offset,
          instance.port + (1 - offset),
        ]);
        expect(instance.child).toMatchObject({ exitCode: null, signalCode: null });
        control.unblock();
        await Promise.allSettled([starting]);
        await instance.cleanup();
      } finally {
        control.unblock();
        await Promise.allSettled([starting]);
      }
    },
  );

  it.for([false, true])(
    "orders concurrent starts around an intervening stop=%s",
    async (interveningStop, { signal }) => {
      const control = await createGatewayControl();
      const { instance } = await createFakeGateway(
        interveningStop ? "held-ready,ready" : "held-ready",
        { control },
      );
      // Startup ordering must not depend on native bootstrap consuming the readiness budget.
      const { restoreClock } = freezePolicyClock(signal);
      let firstStart: Promise<void> | undefined;
      let stopped: Promise<void> | undefined;
      let secondStart: Promise<void> | undefined;
      try {
        firstStart = trackOperation(instance.startGateway());
        await Promise.race([control.reached, firstStart]);
        if (interveningStop) {
          stopped = trackOperation(instance.stopGateway());
        }
        let secondSettled = false;
        let settledBeforeReady: boolean | undefined;
        secondStart = trackOperation(
          instance.startGateway().finally(() => {
            secondSettled = true;
          }),
        );
        if (!interveningStop) {
          await expectReady(instance);
        }
        // Healthy readiness cannot settle startup while its admission response is held.
        control.observers.beforeRelease = () => {
          settledBeforeReady = secondSettled;
        };
        await control.release();
        if (interveningStop) {
          await Promise.allSettled([firstStart]);
          await stopped;
          await secondStart;
          expect(control.launches[1]).not.toBe(control.launches[0]);
          expect(isProcessAlive(control.launches[0]!)).toBe(false);
        } else {
          await Promise.all([firstStart, secondStart]);
          expect(settledBeforeReady).toBe(false);
        }
        expect(control.launches).toHaveLength(interveningStop ? 2 : 1);
        expect(instance.child?.pid).toBe(
          (process.platform === "win32" ? control.parents : control.launches)[
            interveningStop ? 1 : 0
          ],
        );
        await expectReady(instance);
      } finally {
        restoreClock();
        control.unblock();
        await Promise.allSettled([firstStart, stopped, secondStart]);
      }
    },
  );

  it("joins shared entrypoint preparation without launching the cancelled owner", async () => {
    const controller = new AbortController();
    const cancelled = new Error("instance owner cancelled during preparation");
    const control = await createGatewayControl();
    const { instance, tracePath, readAttempts } = await createFakeGateway("ready", {
      control: { url: control.url, holdPreparation: true },
      signal: controller.signal,
    });
    const first = trackOperation(instance.startGateway());
    const firstOutcome = first.catch((error: unknown) => error);
    await Promise.race([control.reached, first]);
    const borrower = await createOpenClawTestInstance({
      name: "shared-entrypoint-borrower",
      cwd: path.dirname(tracePath),
      env: {
        OPENCLAW_FAKE_GATEWAY_SEQUENCE: "ready",
        OPENCLAW_FAKE_GATEWAY_TRACE: tracePath,
        OPENCLAW_FAKE_GATEWAY_CONTROL: control.url,
      },
    });
    fakeInstances.push({ instance: borrower });
    const borrowedStart = trackOperation(borrower.startGateway());
    const borrowedOutcome = borrowedStart.catch((error: unknown) => error);
    controller.abort(cancelled);
    const laterStart = trackOperation(instance.startGateway()).catch((error: unknown) => error);
    // Observe cancellation only after the original shared preparation is joined.
    await control.release();
    expect(await firstOutcome).toBe(cancelled);
    expect(await laterStart).toBeInstanceOf(Error);
    expect(await borrowedOutcome).toBeUndefined();
    expect(instance.child).toBeUndefined();
    expect(control.launches).toHaveLength(1);
    expect((await readAttempts()).map((attempt) => attempt.port)).toEqual([borrower.port]);
    await expectReady(borrower);
  });

  it.each(["pending probe", "readiness handoff"] as const)(
    "rolls back the real child after owner cancellation during %s",
    async (phase) => {
      const controller = new AbortController();
      const cancelled = new Error(`instance owner cancelled during ${phase}`);
      const pending = phase === "pending probe";
      const control = pending ? await createGatewayControl() : undefined;
      const { instance } = await createFakeGateway(pending ? "held-ready" : "ready", {
        control,
        signal: controller.signal,
      });
      const nativeFetch = globalThis.fetch;
      let child: typeof instance.child;
      const fetchSpy = pending
        ? undefined
        : vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
            const response = await nativeFetch(...args);
            if (args[0] === `http://127.0.0.1:${instance.port}/readyz`) {
              const json = response.json.bind(response);
              vi.spyOn(response, "json").mockImplementation(async () => {
                const result: unknown = await json();
                child = instance.child;
                controller.abort(cancelled);
                return result;
              });
            }
            return response;
          });
      try {
        const startup = trackOperation(instance.startGateway());
        const outcome = startup.catch((error: unknown) => error);
        if (control) {
          await Promise.race([control.reached, startup]);
          child = instance.child;
          expect(child).toBeDefined();
          controller.abort(cancelled);
        }
        expect(await outcome).toBe(cancelled);
        expect(child).toBeDefined();
        expect(instance.child).toBeUndefined();
        expect(child?.stdout.closed).toBe(true);
        expect(child?.stderr.closed).toBe(true);
        expect(isProcessAlive(child!.pid!)).toBe(false);
        if (pending) {
          expect(inspectManagedProcessGroup(child!, { errorPolicy: "indeterminate" })).toBe("dead");
          await expect(fs.stat(instance.state.root)).resolves.toBeDefined();
        }
      } finally {
        fetchSpy?.mockRestore();
      }
    },
  );

  it("joins a cancelled CLI command before releasing instance state", async ({ signal }) => {
    const controller = new AbortController();
    const control = await createGatewayControl();
    const { instance, tracePath, readAttempts } = await createFakeGateway("cli", {
      control,
      signal: controller.signal,
    });
    const command = trackOperation(instance.cli(["wait"], { timeoutMs: 1_000 }));
    const outcome = command.catch((error: unknown) => error);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          control.reached,
          command,
          `Child exited before writing ${tracePath}.cli-ready`,
        ),
        signal,
      );
      const [attempt] = await readAttempts();
      expect(isProcessAlive(attempt!.pid)).toBe(true);
      controller.abort(new Error("instance owner cancelled during CLI"));
      expect(await outcome).toMatchObject({ message: expect.stringContaining("aborted") });
      expect(isProcessAlive(attempt!.pid)).toBe(false);
      await expect(fs.stat(instance.state.root)).resolves.toBeDefined();
      await expect(instance.cli(["0"])).rejects.toThrow();
      await instance.cleanup();
      await expectPathMissing(instance.state.root);
    } finally {
      controller.abort();
      control.unblock();
      await outcome;
    }
  });

  it("starts a ready replacement after a real readiness deadline expires", async ({ signal }) => {
    const control = await createGatewayControl();
    const { instance } = await createFakeGateway("never-ready,ready", { control });
    let firstOwnerPid: number | undefined;
    control.observers.onLaunch = () => {
      firstOwnerPid = instance.child?.pid;
    };
    // Charge the unchanged real deadline only after the child proves it is running but unready.
    const { clock, now, fixtureTime, restoreClock } = freezePolicyClock(signal);
    let readinessStartedAt: number | undefined;
    const nativeFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await nativeFetch(...args);
      if (
        args[0] === `http://127.0.0.1:${instance.port}/readyz` &&
        readinessStartedAt === undefined
      ) {
        const json = response.json.bind(response);
        vi.spyOn(response, "json").mockImplementation(async () => {
          const result: unknown = await json();
          expect(response.status).toBe(200);
          expect(result).toEqual({ ready: false });
          const startedAt = now();
          readinessStartedAt = startedAt;
          clock.mockImplementation(() => fixtureTime + now() - startedAt);
          return result;
        });
      }
      return response;
    });
    let error: unknown;
    try {
      error = await trackOperation(instance.startGateway()).catch((failure: unknown) => failure);
    } finally {
      restoreClock();
      fetchSpy.mockRestore();
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timeout waiting for gateway readiness");
    expect(readinessStartedAt).toBeTypeOf("number");
    const firstPid = control.launches[0];
    expect(firstPid).toBeTypeOf("number");
    expect(firstOwnerPid).toBeTypeOf("number");
    const receipt = readReadinessReceipt(error);
    expect(receipt).toMatchObject({
      child: { pid: firstOwnerPid, exitCode: null, signalCode: null },
      lastFailedResponse: { phase: "complete", status: 200, ready: false },
    });
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(1_000);
    // Assert automatic failure cleanup before a replacement start can reap the owner.
    expect(instance.child).toBeUndefined();
    expect(isProcessAlive(firstPid as number)).toBe(false);
    await expect(fs.stat(instance.state.root)).resolves.toBeDefined();

    await startGatewayForPortLifecycle(instance, signal);
    await expectReady(instance);
    expect(control.launches).toHaveLength(2);
    expect(control.launches[1]).not.toBe(firstPid);
    expect(instance.child?.pid).toBe(
      (process.platform === "win32" ? control.parents : control.launches)[1],
    );
    expect(isProcessAlive(firstPid as number)).toBe(false);
    await instance.stopGateway();
    expect(instance.child).toBeUndefined();
    expect(isProcessAlive(control.launches[1]!)).toBe(false);
    await expect(fs.stat(instance.state.root)).resolves.toBeDefined();
    await instance.cleanup();
    await expectPathMissing(instance.state.root);
  });

  it.runIf(process.platform === "linux").for(["cleanup", "forced-stop"] as const)(
    "reclaims a stopped detached descendant before releasing Gateway state (%s)",
    async (action, { signal }) => {
      const { instance, tracePath } = await createFakeGateway("detached-stopped");
      await instance.startGateway();
      const escapedPid = Number(await fs.readFile(`${tracePath}.escaped-pid`, "utf8"));
      expect(Number.isSafeInteger(escapedPid) && escapedPid > 1).toBe(true);
      const aliveAtStateRelease: boolean[] = [];
      const releaseState = instance.state.cleanup.bind(instance.state);
      const release = vi.spyOn(instance.state, "cleanup").mockImplementation(async () => {
        aliveAtStateRelease.push(isProcessAlive(escapedPid));
        await releaseState();
      });
      await runQaGatewayFixture(
        async () => {
          expect(isProcessAlive(escapedPid)).toBe(true);
          if (action === "forced-stop") {
            const child = instance.child!;
            const exited = once(child, "exit");
            const closed = once(child, "close");
            child.kill("SIGKILL");
            expect(await exited).toEqual([null, "SIGKILL"]);
            expect(await closed).toEqual([null, "SIGKILL"]);
            await instance.stopGateway();
            expect(isProcessAlive(escapedPid)).toBe(false);
          }
          await instance.cleanup();
          expect(isProcessAlive(escapedPid)).toBe(false);
          expect(aliveAtStateRelease).toEqual([false]);
          await expectPathMissing(instance.state.root);
        },
        async () => {
          release.mockRestore();
          // Rescue is independent of the owner under test, including a failed baseline.
          if (isProcessAlive(escapedPid)) {
            process.kill(-escapedPid, "SIGKILL");
          }
          await withinTest(waitForDead(escapedPid, signal), signal);
        },
      );
    },
  );

  it.each(["stopGateway", "cleanup"] as const)(
    "does not launch after %s settles during entrypoint preparation",
    async (method) => {
      const control = await createGatewayControl();
      const { instance } = await createFakeGateway("ready", {
        control: { url: control.url, holdPreparation: true },
      });
      const firstStart = trackOperation(instance.startGateway());
      await Promise.race([control.reached, firstStart]);
      await expect(isPortReserved(instance.port)).resolves.toBe(true);
      let teardownSettled = false;
      let launchedAfterTeardown = false;
      control.observers.onLaunch = () => {
        launchedAfterTeardown ||= teardownSettled;
      };
      const teardown = trackOperation(
        instance[method]().finally(() => {
          teardownSettled = true;
        }),
      );

      // A valid owner may join startup or cancel this instance. Release preparation
      // before joining teardown so either policy can complete without a deadlock.
      await control.release();
      const [, stopped] = await Promise.allSettled([firstStart, teardown]);
      expect(stopped.status).toBe("fulfilled");
      expect(launchedAfterTeardown).toBe(false);
      expect(instance.child).toBeUndefined();
      await instance.cleanup();
      await expectPathMissing(instance.state.root);
      for (const pid of control.launches) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
  );

  it.for([
    { action: "legacy-refuse", typed: true },
    { action: "profile-legacy-refuse", typed: true },
    { action: "late-legacy-refuse", typed: true },
    { action: "startup-legacy-refuse", typed: true },
    { action: "startup-late-legacy-refuse", typed: true },
    ...[
      "legacy-stdout",
      "legacy-status1",
      "legacy-no-advice",
      "profile-mismatch",
      "startup-no-advice",
      "startup-warning",
      "near",
      "prefixed",
      "stdout",
      "status2",
      "unrelated",
      ...(process.platform === "win32" ? [] : ["signal"]),
    ].map((action) => ({ action, typed: false })),
  ])(
    "classifies $action without borrowing a previous refusal",
    async ({ action, typed }, { signal }) => {
      const control = action.includes("late-") ? await createGatewayControl() : undefined;
      const { instance, readAttempts } = await createFakeGateway(
        (action === "profile-mismatch" ? "profile-legacy-refuse" : action) + ",config-refuse",
        { control },
      );
      if (action.startsWith("profile-") || action.startsWith("startup-")) {
        instance.env.OPENCLAW_PROFILE =
          action === "profile-mismatch" ? "different-fixture" : "qa-fixture";
      }
      const message = action.startsWith("startup-")
        ? LEGACY_STARTUP_FAILURE
        : action === "profile-legacy-refuse"
          ? PROFILED_LEGACY_MIGRATION_REFUSAL
          : LEGACY_MIGRATION_REFUSAL;
      const exited = control ? observeGatewayExit(control, instance) : undefined;
      const { restoreClock } = freezePolicyClock(signal);
      const startup = trackOperation(instance.startGateway());
      const outcome = startup.catch((error: unknown) => error);
      try {
        if (control) {
          await Promise.race([exited!, outcome]);
          await Promise.race([control.reached, outcome]);
          expect(instance.child?.stderr.closed).toBe(false);
          expect(instance.logs()).not.toContain(message);
          await control.release();
        }
        const error = await outcome;
        if (typed) {
          expect(error).toBeInstanceOf(GatewayStartupRefusedError);
          expect(error).toMatchObject({
            reason: "legacy-migration-required",
            exitCode: 78,
            signalCode: null,
            legacyStorePath: LEGACY_STORE_PATH,
            stderr: message + "\n",
            cause: expect.any(Error),
          });
          const nextError = await instance.startGateway().catch((failure: unknown) => failure);
          expect(nextError).toBeInstanceOf(Error);
          expect(nextError).not.toBeInstanceOf(GatewayStartupRefusedError);
        } else {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(GatewayStartupRefusedError);
        }
        expect(await readAttempts()).toHaveLength(typed ? 2 : 1);
        expect(instance.logs()).not.toContain(RESTART_MARKER);
        expect(instance.child).toBeUndefined();
      } finally {
        control?.unblock();
        restoreClock();
        await outcome;
      }
    },
  );

  it("does not retry a drained migration refusal after owner cancellation", async () => {
    const controller = new AbortController();
    const control = await createGatewayControl();
    const { instance, readAttempts } = await createFakeGateway("late-refuse,ready", {
      startTimeoutMs: 10_000,
      control,
      signal: controller.signal,
    });
    const exited = observeGatewayExit(control, instance);
    const startup = trackOperation(instance.startGateway());
    const outcome = startup.catch((error: unknown) => error);
    await Promise.race([exited, startup]);
    await Promise.race([control.reached, startup]);
    expect(instance.child?.stderr.closed).toBe(false);
    controller.abort(new Error("instance owner cancelled during refusal drain"));
    await control.release();
    const result = await outcome;
    const attempts = await readAttempts();
    expect(attempts).toHaveLength(1);
    expect(result).toBeInstanceOf(Error);
    expect(instance.logs()).not.toContain(RESTART_MARKER);
    expect(instance.child).toBeUndefined();
    expect(isProcessAlive(attempts[0]!.pid)).toBe(false);
  });

  it.for(["refuse", "late-refuse"])(
    "restarts one %s refusal with identical launch state and owns the ready child",
    async (refusalAction, { signal: testSignal }) => {
      const control = refusalAction === "late-refuse" ? await createGatewayControl() : undefined;
      const { instance, readAttempts } = await createFakeGateway(`${refusalAction},ready`, {
        control,
      });
      // This case owns refusal/retry ordering, not deadline expiry. Keep native
      // bootstrap and HTTP gates real without charging them to the policy clock.
      const { restoreClock } = freezePolicyClock(testSignal);
      const exited = control ? observeGatewayExit(control, instance) : undefined;
      const startup = trackOperation(instance.startGateway());
      try {
        if (control) {
          expect(await Promise.race([exited!, startup])).toEqual({
            code: 1,
            signal: null,
            at: expect.any(Number),
          });
          await Promise.race([control.reached, startup]);
          expect(instance.child?.stderr.closed).toBe(false);
          expect(instance.logs()).not.toContain(MIGRATION_CONVERGENCE_REFUSAL);
          // /launch installs the exit observer before the leader proceeds. Only
          // release its waiting stderr writer after that native exit, never a timer.
          await control.release();
        }
        await startup;
      } finally {
        restoreClock();
        control?.unblock();
        await Promise.allSettled([startup]);
      }
      const attempts = await readAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.pid).not.toBe(attempts[1]?.pid);
      expect({ ...attempts[0], pid: 0 }).toEqual({ ...attempts[1], pid: 0 });
      expect(instance.logs()).toContain(MIGRATION_CONVERGENCE_REFUSAL);
      expect(instance.logs()).toContain(RESTART_MARKER);
      const readyPid = instance.child?.pid;
      expect(readyPid).toBeTypeOf("number");
      await instance.stopGateway();
      expect(instance.child).toBeUndefined();
      expect(isProcessAlive(readyPid as number)).toBe(false);
    },
  );

  it("preserves both refusals and never spawns a third gateway", async ({ signal }) => {
    const control = await createGatewayControl();
    const { instance, readAttempts } = await createFakeGateway("refuse,refuse,ready", { control });
    const children: NonNullable<typeof instance.child>[] = [];
    const previousOutputClosed: boolean[] = [];
    control.observers.onLaunch = () => {
      const previous = children.at(-1);
      if (previous) {
        previousOutputClosed.push(previous.stdout.closed && previous.stderr.closed);
      }
      if (instance.child) {
        children.push(instance.child);
      }
    };
    // Retry admission is the contract here; native process startup/exit must not
    // spend the policy budget before both refusal facts reach the parent.
    const { restoreClock } = freezePolicyClock(signal);
    const servers = vi.spyOn(net, "createServer");
    let reservation: net.Server | undefined;
    const startup = trackOperation(instance.startGateway());
    try {
      await expect(startup).rejects.toThrow("gateway exited before readiness (code=1 signal=null)");
      reservation = servers.mock.results.find(
        (result) => result.type === "return" && result.value.listening,
      )?.value;
      expect(reservation).toBeDefined();
    } finally {
      restoreClock();
      await Promise.allSettled([startup]);
      servers.mockRestore();
    }
    const attempts = await readAttempts();
    expect(attempts).toHaveLength(2);
    expect(children).toHaveLength(2);
    expect(previousOutputClosed).toEqual([true]);
    expect(instance.readiness.map(({ outcome, child }) => ({ outcome, child }))).toEqual(
      children.map(({ pid }) => ({
        outcome: "child-exit",
        child: { pid, exitCode: 1, signalCode: null },
      })),
    );
    for (const child of children) {
      expect(child.exitCode).toBe(1);
      expect(child.signalCode).toBeNull();
      expect(child.stdout.closed && child.stderr.closed).toBe(true);
    }
    expect(attempts.every(({ pid }) => !isProcessAlive(pid))).toBe(true);
    expect(instance.child).toBeUndefined();
    expect(instance.logs().split(MIGRATION_CONVERGENCE_REFUSAL)).toHaveLength(3);
    expect(instance.logs().split(RESTART_MARKER)).toHaveLength(2);
    await expect(isPortReserved(instance.port)).resolves.toBe(true);
    await instance.cleanup();
    // Once its claim is released, another worker may bind the numeric port.
    expect(reservation?.listening).toBe(false);
    expect(reservation?.address()).toBeNull();
  });

  it.runIf(process.platform !== "win32").for(["refusal", "terminal"] as const)(
    "joins inherited stdio before settling %s startup",
    async (mode, { signal }) => {
      const refusal = mode === "refusal";
      const control = await createGatewayControl();
      const { instance, tracePath, readAttempts } = await createFakeGateway(
        refusal ? "refusal-drain,ready" : "terminal-drain,ready",
        { startTimeoutMs: refusal ? 500 : 300, stopTimeoutMs: refusal ? 1_500 : 100, control },
      );
      const { clock, now, fixtureTime, restoreClock } = freezePolicyClock(signal);
      const exited = observeGatewayExit(control, instance);
      let settled = false;
      const startup = trackOperation(
        instance.startGateway().finally(() => {
          settled = true;
        }),
      );
      try {
        const firstExit = await Promise.race([exited, startup]);
        expect(firstExit).toMatchObject({ code: refusal ? 1 : 7, signal: null });
        if (!firstExit) {
          throw new Error("startup settled before leader exit");
        }
        const drainingPid = Number(await fs.readFile(tracePath + ".draining-pid", "utf8"));
        const drainStartedAt = now();
        clock.mockImplementation(() => fixtureTime + now() - drainStartedAt);
        if (refusal) {
          // Exhaust retry admission while the exited child's writer still owns stderr.
          const deadline = firstExit.at + 500;
          while (Date.now() < deadline) {
            await delay(deadline - Date.now());
          }
          expect(instance.child?.stderr.closed).toBe(false);
          expect(isProcessAlive(drainingPid)).toBe(true);
          expect(settled).toBe(false);
          await fs.writeFile(tracePath + ".draining-release", "");
        }
        const error = await startup.catch((failure: unknown) => failure);
        expect(String(error)).toContain("gateway exited before readiness");
        expect(String(error)).toContain(
          refusal ? MIGRATION_CONVERGENCE_REFUSAL : "terminal startup failure",
        );
        expect(instance.logs()).not.toContain(RESTART_MARKER);
        expect(await readAttempts()).toHaveLength(1);
        expect(instance.child).toBeUndefined();
        await withinTest(waitForDead(drainingPid, signal), signal);
        expect(isProcessAlive(drainingPid)).toBe(false);
        if (!refusal) {
          await expect(isPortReserved(instance.port)).resolves.toBe(true);
          clock.mockReturnValue(Date.now());
          await trackOperation(instance.startGateway());
          const attempts = await readAttempts();
          expect(attempts).toHaveLength(2);
          expect(attempts[1]?.pid).not.toBe(attempts[0]?.pid);
          expect(instance.child?.pid).toBe(attempts[1]?.pid);
          await instance.stopGateway();
          expect(isProcessAlive(attempts[1]!.pid)).toBe(false);
        }
      } finally {
        restoreClock();
        await fs.writeFile(tracePath + ".draining-release", "");
        await Promise.allSettled([startup]);
      }
    },
  );

  it.each([
    "joined closure",
    "held pipe",
    "unverified tree",
    "unverified exited leader",
    "exited forced tree",
    "exited closed pipes",
    "taskkill timeout",
    "taskkill exception",
  ])("observes Windows %s after blocking termination", async (label) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stopLog = testing.createBoundedStringLog();
    const preclosed = label === "exited closed pipes";
    const forceWindowsTree = label === "exited forced tree" || preclosed;
    const exitedLeader = label === "unverified exited leader" || forceWindowsTree;
    const heldPipe = label === "held pipe";
    const processState = createGatewayProcessState({ exitCode: exitedLeader ? 7 : null });
    const kill = vi.fn(() => true);
    // The stub provides every process/pipe member consumed by the stopper.
    const child = Object.assign(processState, {
      pid: process.pid,
      kill,
      stdout,
      stderr,
    }) as unknown as Parameters<typeof testing.stopWindowsGatewayProcess>[0];
    const closePipes = async () => {
      const closed = [stdout, stderr].map((pipe) =>
        pipe.closed ? undefined : once(pipe, "close"),
      );
      stdout.destroy();
      stderr.destroy();
      await Promise.all(closed);
    };
    if (preclosed) {
      await closePipes();
    }
    const observed = createDeferred();
    let offset = 0;
    let scheduled = false;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    const runTaskkill = vi.fn(() => {
      offset += 1_000;
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          processState.exitCode = heldPipe ? null : 0;
          processState.signalCode = heldPipe ? "SIGTERM" : null;
          stdout.destroy();
          if (!heldPipe) {
            stderr.destroy();
          }
          observed.resolve();
        });
      }
      if (label === "taskkill exception") {
        throw Object.assign(new Error("private exception text must not be logged"), {
          code: "EACCES",
        });
      }
      if (label === "taskkill timeout" && runTaskkill.mock.calls.length === 2) {
        return {
          status: null,
          signal: "SIGKILL" as const,
          error: Object.assign(new Error("private timeout text must not be logged"), {
            code: "ETIMEDOUT",
          }),
        };
      }
      return { status: label === "joined closure" || heldPipe ? 0 : 1, signal: null };
    });
    try {
      const stop = testing.stopWindowsGatewayProcess(
        child,
        Date.now() + 500,
        250,
        { runTaskkill, forceWindowsTree },
        stopLog,
      );
      if (label === "joined closure") {
        expect(await stop).toBe(true);
        expect(child.exitCode).toBe(0);
        expect(stdout.closed && stderr.closed).toBe(true);
        expect(stopLog).toEqual([]);
      } else {
        await expect(stop).rejects.toBeInstanceOf(Error);
        if (exitedLeader) {
          await expect(stop).rejects.toMatchObject({ processTreeState: "indeterminate" });
          expect(kill).not.toHaveBeenCalled();
          expect([stdout.closed, stderr.closed]).toEqual([preclosed, preclosed]);
        }
        if (heldPipe) {
          expect(stderr.closed).toBe(false);
        }
        expect(stopLog).toHaveLength(1);
        const line = stopLog[0]!;
        const diagnostic = JSON.parse(
          line.slice("[openclaw-test-instance] Windows shutdown ".length),
        );
        expect(diagnostic.errorCode).toBe(
          label === "taskkill exception" ? "EACCES" : "EPROCESSGROUP_CLEANUP_FAILED",
        );
        for (const attempt of diagnostic.taskkill) {
          expect(attempt.elapsedMs).toBeGreaterThanOrEqual(1_000);
        }
        if (label === "taskkill timeout") {
          expect(diagnostic.taskkill[1].errorCode).toBe("ETIMEDOUT");
        }
        if (label === "taskkill exception") {
          expect(diagnostic.taskkill[0].threw).toBe(true);
        }
        expect(line).not.toContain("private");
        expect(Buffer.byteLength(line)).toBeLessThan(1_024);
      }
    } finally {
      if (scheduled) {
        await observed.promise;
      }
      await closePipes().finally(() => clock.mockRestore());
    }
  });

  describe("UTF-8 log trimming", () => {
    let exerciseTrimming: () => Promise<void>;
    let stopTrimming: (() => Promise<void>) | undefined;

    afterEach(async () => {
      await stopTrimming?.();
    });

    // Use the fixture-hook budget for TS bootstrap before exercising trimming.
    beforeEach(async ({ signal }) => {
      const cases = [
        { chunks: ["€a", "b"], limit: 4, expected: "ab" },
        { chunks: ["old", "recent"], limit: 8, expected: "ldrecent" },
        { chunks: ["€abc"], limit: 4, expected: "abc" },
        { chunks: ["😀a", "b"], limit: 5, expected: "ab" },
        { chunks: ["😀a"], limit: 1, expected: "a" },
        { chunks: ["😀"], limit: 1, expected: "" },
        { chunks: ["😀"], limit: 3, expected: "" },
        { chunks: ["€"], limit: 2, expected: "" },
        { chunks: ["a", "€"], limit: 3, expected: "€" },
        { chunks: ["x".repeat(32)], limit: 32, expected: "x".repeat(32), truncated: false },
      ];
      const control = await createGatewayControl();
      // A synchronous regression must be killed and joined outside the Vitest event loop.
      const script = `
      import assert from "node:assert/strict";
      import { testing } from ${JSON.stringify(new URL("./openclaw-test-instance.ts", import.meta.url).href)};
      ${CONTROL_REQUEST_SOURCE}
      process.stderr.write("loaded actual log helper; waiting to start UTF-8 cases\\n");
      await waitForControl(${JSON.stringify(`${control.url}/wait`)});
      for (const { chunks, limit, expected, truncated = true } of JSON.parse(process.argv[1])) {
        const log = testing.createBoundedStringLog(limit);
        for (const chunk of chunks) {
          testing.appendLogChunk(log, chunk);
          assert.ok(Buffer.byteLength(log.join("")) <= limit);
        }
        assert.equal(log.join(""), expected);
        assert.ok(!log.join("").includes("�"));
        assert.equal(testing.formatLogs(log, []).includes("output truncated to last"), truncated);
      }
      process.stdout.write("UTF-8 cases completed");
    `;
      const completed = promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script, JSON.stringify(cases)],
        { signal, encoding: "utf8" },
      );
      const closed = new Promise<void>((resolve) => {
        completed.child.once("close", () => resolve());
      });
      stopTrimming = async () => {
        completed.child.kill("SIGKILL");
        await closed;
      };
      exerciseTrimming = async () => {
        await control.release();
        const { stdout } = await completed;
        expect(stdout).toBe("UTF-8 cases completed");
      };
      await trackOperation(
        Promise.race([
          control.reached,
          completed.then(() => {
            throw new Error("log helper child exited before reaching the trimming gate");
          }),
        ]),
      );
    });

    it("terminates UTF-8 log trimming within the byte cap", { timeout: 15_000 }, async () => {
      await trackOperation(exerciseTrimming());
    });
  });

  describe("readiness", () => {
    const active: { abort: AbortController; result: Promise<unknown> }[] = [];
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));
    afterEach(async () => {
      for (const { abort } of active) {
        abort.abort();
      }
      await vi.runAllTimersAsync();
      await Promise.all(active.splice(0).map(({ result }) => result));
      vi.useRealTimers();
    });

    function probe(
      fetchImpl: typeof fetch,
      timeout = 25,
      processState = createGatewayProcessState(),
    ) {
      const abort = new AbortController();
      const record = vi.fn<(diagnostic: GatewayReadinessDiagnostic) => void>();
      const result = waitForReady(fetchImpl, timeout, {
        processState,
        signal: abort.signal,
        record,
      }).catch((error: unknown) => error);
      active.push({ abort, result });
      return {
        abort,
        record,
        result,
        processState,
        async done(ms = timeout) {
          await vi.advanceTimersByTimeAsync(ms);
          const error = await result;
          expect(processState.listenerCount("exit")).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
          return error;
        },
      };
    }

    it("fails startup waits immediately after signaled gateway exits", async () => {
      const fetchImpl = vi.fn<typeof fetch>();
      const run = probe(
        fetchImpl,
        10_000,
        createGatewayProcessState({ pid: 12345, signalCode: "SIGTERM" }),
      );
      const error = await run.done(0);
      expect(String(error)).toContain("gateway exited before readiness");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(readReadinessReceipt(error)).toMatchObject({
        attempts: 0,
        lastProbe: null,
        lastFailedResponse: null,
        child: { pid: 12345, exitCode: null, signalCode: "SIGTERM" },
      });
    });

    it.each(["transport failure", "proxy refusal"] as const)(
      "backs off readiness probes during a %s and recovers when the listener returns",
      async (failure) => {
        let listening = false;
        const fetchImpl = vi.fn<typeof fetch>(async (url) => {
          if (listening) {
            return jsonResponse(
              String(url).endsWith("/startupz") ? { ok: true, status: "started" } : { ready: true },
            );
          }
          if (failure === "transport failure") {
            throw new TypeError("fetch failed");
          }
          return new Response("synthetic upstream refusal", { status: 502 });
        });
        const run = probe(fetchImpl, 8_000);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(16);
        expect(run.record).not.toHaveBeenCalled();
        listening = true;
        expect(await run.done(500)).toBeUndefined();
        expect(run.record.mock.calls[0]![0].outcome).toBe("ready");
      },
    );

    it("preserves the cancellation reason while a readiness backoff is pending", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("refusal", { status: 502 }));
      const run = probe(fetchImpl, 8_000);
      await vi.advanceTimersByTimeAsync(0);
      const reason = new Error("synthetic readiness cancellation");
      run.abort.abort(reason);
      expect(await run.done(0)).toBe(reason);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(run.record.mock.calls[0]![0].outcome).toBe("aborted");
    });

    it("waits for startup admission after the gateway readiness probe reports ready", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ ready: false, failing: ["startup-sidecars"] }, 503))
        .mockResolvedValueOnce(
          jsonResponse({
            ready: true,
            agentDatabases: [{ code: "agent-database-inspection-pending" }],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ ready: true }))
        .mockResolvedValueOnce(jsonResponse({ ok: false, status: "starting" }, 503))
        .mockResolvedValueOnce(jsonResponse({ ready: true }))
        .mockResolvedValueOnce(jsonResponse({ ok: true, status: "started" }));
      const run = probe(fetchImpl, 1_000);
      expect(await run.done()).toBeUndefined();
      expect(run.record.mock.calls[0]![0]).toMatchObject({
        outcome: "ready",
        lastProbe: { attempt: 4, status: 200, endpoint: "/startupz", startupStatus: "started" },
        lastFailedResponse: {
          attempt: 3,
          status: 503,
          endpoint: "/startupz",
          startupStatus: "starting",
        },
      });
    });

    it("reports terminal agent admission refusal before the startup deadline", async () => {
      const refusal = {
        code: "agent-database-inspection-failed",
        reason: "Legacy session store requires migration: /synthetic/agents/main/sessions",
        repairHint: "Run openclaw doctor --fix, then restart.",
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ready: false, agentDatabases: [refusal] }, 503));
      const run = probe(fetchImpl, 1_000);
      const error = await run.done(0);
      expect(error).toMatchObject({ name: "GatewayAgentAdmissionError", refusals: [refusal] });
      expect(String(error)).toContain(refusal.reason);
      expect(String(error)).toContain(refusal.repairHint);
      expect(error).not.toHaveProperty("exitCode");
      expect(run.record.mock.calls[0]![0]).toMatchObject({ outcome: "agent-refused", attempts: 1 });
    });

    it("bounds not-ready diagnostics without exposing response details", async () => {
      const privateDetail = "private-channel-" + "x".repeat(2_048);
      const allowed = ["startup-sidecars", "gateway-draining", "state-database", "internal"];
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            ready: false,
            failing: [
              ...allowed,
              privateDetail,
              null,
              { privateDetail },
              false,
              ...Array<string>(12).fill(privateDetail),
            ],
            config: { privateDetail },
            error: privateDetail,
          },
          503,
          { "x-private-detail": privateDetail },
        ),
      );
      const error = await probe(fetchImpl, 100).done();
      expect(String(error)).toContain("timeout waiting for gateway readiness");
      for (const secret of [privateDetail, "x-private-detail", "config"]) {
        expect(String(error)).not.toContain(secret);
      }
      expect(readReadinessReceipt(error).lastProbe).toMatchObject({
        status: 503,
        ready: false,
        failing: [...allowed, "other", "other", "other", "other"],
        omittedFailing: 12,
      });
    });

    it.each([
      { status: 502, body: "proxy refusal", phase: "body", error: "invalid-json" },
      { status: 503, body: '{"ready":false}', phase: "complete", ready: false },
      { status: 200, body: '{"ready":false}', phase: "complete", ready: false },
      { status: 503, body: '{"ready":true}', phase: "complete", ready: true },
      { status: 200, body: "{}", phase: "complete" },
    ])(
      "retains the last failed response ($status/$body) before a final timeout",
      async (failed) => {
        const privateDetail = "synthetic-proxy-credential";
        const fetchImpl = createStalledReadinessFetch("headers")
          .mockResolvedValueOnce(jsonResponse({ ready: false }, 429))
          .mockResolvedValueOnce(
            new Response(failed.body, {
              status: failed.status,
              headers: { "x-private": privateDetail },
            }),
          )
          .mockRejectedValueOnce(new Error(privateDetail));
        const run = probe(fetchImpl, 79);
        const error = await run.done();
        const receipt = readReadinessReceipt(error);
        expect(receipt).toMatchObject({
          attempts: 4,
          lastProbe: { phase: "headers", error: "timeout" },
          lastFailedResponse: {
            attempt: 2,
            phase: failed.phase,
            status: failed.status,
            ...(failed.ready === undefined ? {} : { ready: failed.ready }),
            ...(failed.error === undefined ? {} : { error: failed.error }),
          },
        });
        const diagnostic = run.record.mock.calls[0]![0];
        expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
        expect(String(error)).not.toContain(privateDetail);
      },
    );

    it.each(["timeout", "child-exit", "aborted"] as const)(
      "does not replace a failed response with an expired body on %s",
      async (outcome) => {
        const lateBody = createDeferred<unknown>();
        const response = new Response(null, { status: 503 });
        response.json = () => lateBody.promise;
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response("synthetic refusal", { status: 502 }))
          .mockResolvedValueOnce(response);
        const run = probe(fetchImpl);
        await vi.advanceTimersByTimeAsync(10);
        if (outcome === "child-exit") {
          run.processState.exitCode = 7;
          run.processState.emit("exit", 7, null);
        } else if (outcome === "aborted") {
          run.abort.abort(new Error("synthetic cancellation"));
        }
        const failure = await run.done(15);
        const diagnostic = run.record.mock.calls[0]![0];
        expect(diagnostic).toMatchObject({
          outcome,
          lastProbe: { attempt: 2, phase: "body", status: 503 },
          lastFailedResponse: { attempt: 1, phase: "body", status: 502, error: "invalid-json" },
        });
        if (outcome !== "aborted") {
          expect(readReadinessReceipt(failure).lastFailedResponse).toEqual(
            diagnostic.lastFailedResponse,
          );
        }
        const retained = JSON.stringify(diagnostic);
        lateBody.resolve({ ready: false, failing: ["state-database"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.stringify(diagnostic)).toBe(retained);
      },
    );

    it.each(["fetch-failed", "invalid-json", "body-failed"] as const)(
      "records only the fixed %s readiness category",
      async (category) => {
        const privateDetail = "private readiness failure details";
        const fetchImpl = vi.fn<typeof fetch>(async () => {
          if (category === "fetch-failed") {
            throw new Error(privateDetail);
          }
          if (category === "invalid-json") {
            return new Response("{" + privateDetail, { status: 503 });
          }
          const response = new Response(null, { status: 503 });
          response.json = () => Promise.reject(new Error(privateDetail));
          return response;
        });
        const error = await probe(fetchImpl).done();
        expect(String(error)).toContain("timeout waiting for gateway readiness");
        expect(String(error)).not.toContain(privateDetail);
        expect(readReadinessReceipt(error)).toMatchObject({
          lastProbe: { phase: category === "fetch-failed" ? "headers" : "body", error: category },
          lastFailedResponse: category === "fetch-failed" ? null : { status: 503, error: category },
        });
      },
    );

    it.each(
      (["headers", "body"] as const).flatMap((phase) =>
        [false, true].map((exits) => ({ phase, exits })),
      ),
    )(
      "settles stalled $phase on deadline or child exit (exits=$exits)",
      async ({ phase, exits }) => {
        const fetchImpl = createStalledReadinessFetch(phase);
        const run = probe(fetchImpl, exits ? 5_000 : 25, createGatewayProcessState({ pid: 12345 }));
        let settled = false;
        void run.result.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        if (exits) {
          run.processState.signalCode = "SIGTERM";
          run.processState.emit("exit", null, "SIGTERM");
        }
        const error = await run.done(1);
        expect(String(error)).toContain(
          exits ? "gateway exited before readiness" : "timeout waiting for gateway readiness",
        );
        expect(readReadinessReceipt(error)).toMatchObject({
          attempts: 1,
          elapsedMs: exits ? 24 : 25,
          lastProbe: { phase, error: exits ? "child-exit" : "timeout" },
          child: { pid: 12345, signalCode: exits ? "SIGTERM" : null },
        });
        expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      },
    );

    it("retains an expired probe snapshot after abort-ignoring headers and body arrive", async () => {
      const processState = createGatewayProcessState({ pid: 12345 });
      const headers = createDeferred<Response>();
      const lateJson = vi.fn(async () => {
        processState.exitCode = 7;
        return { ready: false, failing: ["state-database"] };
      });
      const response = new Response(null, { status: 503 });
      response.json = lateJson;
      const fetchImpl = vi.fn<typeof fetch>(() => headers.promise);
      processState.on("removeListener", (event) => {
        if (event === "exit") {
          expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
          headers.resolve(response);
        }
      });
      const error = await probe(fetchImpl, 5_000, processState).done(1_010);
      expect(String(error)).toContain("gateway exited before readiness");
      expect(lateJson).toHaveBeenCalledOnce();
      expect(readReadinessReceipt(error)).toMatchObject({
        attempts: 1,
        lastProbe: { phase: "headers", error: "timeout" },
        lastFailedResponse: null,
        child: { pid: 12345, exitCode: 7, signalCode: null },
      });
    });
  });

  it("creates isolated config and spawn env without mutating process env", async () => {
    const previousHome = process.env.HOME;
    const inst = await createOpenClawTestInstance({
      name: "instance-unit",
      gatewayToken: "gateway-token",
      hookToken: "hook-token",
      config: {
        gateway: {
          bind: "loopback",
        },
      },
      env: {
        OPENCLAW_SKIP_CRON: "0",
      },
    });

    try {
      expect(process.env.HOME).toBe(previousHome);
      expect(inst.homeDir).toBe(path.join(inst.state.root, "home"));
      expect(inst.stateDir).toBe(path.join(inst.homeDir, ".openclaw"));
      expect(inst.configPath).toBe(path.join(inst.stateDir, "openclaw.json"));
      expect(inst.env).toMatchObject({
        HOME: inst.homeDir,
        OPENCLAW_STATE_DIR: inst.stateDir,
        OPENCLAW_CONFIG_PATH: inst.configPath,
        OPENCLAW_SKIP_CRON: "0",
      });

      const config = JSON.parse(await fs.readFile(inst.configPath, "utf8"));
      expect(config).toStrictEqual({
        gateway: {
          bind: "loopback",
          port: inst.port,
          auth: { mode: "token", token: "gateway-token" },
          controlUi: { enabled: false },
        },
        hooks: {
          enabled: true,
          token: "hook-token",
          path: "/hooks",
        },
      });
    } finally {
      await inst.cleanup();
    }

    await expectPathMissing(inst.state.root);
  });
});
