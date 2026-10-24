import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
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
  pid: number;
  port: number;
};

async function releaseFixtures<T>(owners: T[], release: (owner: T) => Promise<void>) {
  const results = await Promise.allSettled(
    owners.splice(0).map(async (owner) => {
      try {
        await release(owner);
      } catch (error) {
        owners.push(owner);
        throw error;
      }
    }),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

afterEach(async () => {
  for (const control of fakeControls) {
    control.unblock();
  }
  await Promise.allSettled(fakeOperations.splice(0));
  const failures = await releaseFixtures(fakeInstances, async ({ instance, writerPidPath }) => {
    await runQaGatewayFixture(
      () => instance.stopGateway(),
      async () => {
        if (writerPidPath) {
          const pid = Number(await fs.readFile(writerPidPath, "utf8"));
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          await waitForDead(pid, AbortSignal.timeout(WRITER_CLEANUP_HANG_GUARD_MS));
        }
      },
    );
    await instance.cleanup();
  });
  failures.push(...(await releaseFixtures(fakeControls, (control) => control.close())));
  if (failures.length) {
    throw new AggregateError(failures, "fake Gateway cleanup failed; owners and roots retained");
  }
  await Promise.all(fakeRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

function trackOperation<T>(operation: Promise<T>): Promise<T> {
  fakeOperations.push(operation.catch(() => undefined));
  return operation;
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

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function createGatewayControl(): Promise<FakeGatewayControl> {
  const reached = createDeferred();
  const released = createDeferred();
  const launches: number[] = [];
  const parents: number[] = [];
  const observers = { beforeRelease: () => {}, onLaunch: () => {} };
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
        server.closeAllConnections();
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
  } = {},
) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "openclaw-test-instance-gateway-"));
  fakeRoots.push(cwd);
  const distDir = path.join(cwd, "dist");
  const tracePath = path.join(cwd, "attempts.jsonl");
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
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
${CONTROL_REQUEST_SOURCE}
const tracePath = process.env.OPENCLAW_FAKE_GATEWAY_TRACE;
const controlUrl = process.env.OPENCLAW_FAKE_GATEWAY_CONTROL;
function spawnInheritedWriter(stream, output) {
  // Windows must keep the writer alive after its leader exits; the HTTP gate owns release.
  const delayed = spawn(process.execPath, ["-e", 'require("node:http").get(process.argv[1] + "/wait", (response) => { response.resume(); response.on("end", () => process[process.argv[2]].write(process.argv[3], () => process.exit(0))); });', controlUrl, stream, output], { detached: process.platform === "win32", stdio: ["ignore", stream === "stdout" ? "inherit" : "ignore", stream === "stderr" ? "inherit" : "ignore"] });
  writeFileSync(tracePath + ".writer-pid", String(delayed.pid));
}
if (controlUrl) await waitForControl(controlUrl + "/launch?pid=" + process.pid + "&parent=" + process.ppid);
const countPath = tracePath + ".count";
let attempt = 1;
try { attempt = Number(readFileSync(countPath, "utf8")) + 1; } catch {}
writeFileSync(countPath, String(attempt));
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
appendFileSync(tracePath, JSON.stringify({ pid: process.pid, port }) + "\\n");
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
if (kind === "cli") {
  process.stderr.write("cli diagnostic\\n");
  if (argv[0] === "wait") {
    setInterval(() => {}, 1_000);
    if (controlUrl) await waitForControl(controlUrl + "/wait");
    await new Promise(() => {});
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
if (kind === "config-refuse") { process.stderr.write("unrelated configuration failure\\n"); process.exit(78); }
if (kind === "refuse") { process.stderr.write("notice\\n" + refusal + " fixture\\n"); process.exit(1); }
if (kind === "late-refuse") {
  spawnInheritedWriter("stderr", refusal + " delayed fixture\\n");
  process.exit(1);
}
if (kind === "terminal-drain" || kind === "refusal-drain") {
  const draining = spawn(process.execPath, ["-e", 'const fs = require("node:fs");const release = process.argv[1];const deadline = Date.now() + 5_000;const timer = setInterval(() => { if (fs.existsSync(release) || Date.now() >= deadline) clearInterval(timer); }, 10);', tracePath + ".draining-release"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  draining.unref();
  writeFileSync(tracePath + ".draining-pid", String(draining.pid));
  process.stderr.write(kind === "refusal-drain" ? refusal + " held fixture\\n" : "terminal startup failure\\n"); process.exit(kind === "refusal-drain" ? 1 : 7);
}
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
  res.end(JSON.stringify({ ready: req.url === "/readyz" }));
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
      `import { writeFileSync } from "node:fs";
${CONTROL_REQUEST_SOURCE}
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
          kind === "startup-late-legacy-refuse",
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
    const { instance } = await createFakeGateway("unrelated,cli,ready,ready");
    const probe = net.connect(instance.port, "127.0.0.1");
    try {
      await withinTest(once(probe, "close"), signal);
    } finally {
      probe.destroy();
    }
    await expect(isPortReserved(instance.port)).resolves.toBe(true);
    await expect(startGatewayForPortLifecycle(instance, signal)).rejects.toThrow(
      "unrelated startup failure",
    );
    expect(instance.child).toBeUndefined();
    await expect(isPortReserved(instance.port)).resolves.toBe(true);
    await expect(instance.cli(["0"])).resolves.toMatchObject({ code: 0, signal: null });
    await startGatewayForPortLifecycle(instance, signal);
    await instance.stopGateway();
    await expect(isPortReserved(instance.port)).resolves.toBe(true);
    await startGatewayForPortLifecycle(instance, signal);
    await expectReady(instance);
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
      await expect(isPortReserved(address.port)).resolves.toBe(true);
    } finally {
      await closeServer(caller);
    }
  });

  it.for(["complete", "overflow", "overflow-close"] as const)(
    "owns complete CLI JSON and diagnostic tails (%s)",
    async (mode, { signal }) => {
      await withEnvAsync({ OPENAI_API_KEY: "ambient-provider-fixture" }, async () => {
        const control = mode === "overflow-close" ? await createGatewayControl() : undefined;
        const { instance, readAttempts } = await createFakeGateway("cli-json", {
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
          const outcomePromise = command.catch((error: unknown) => error);
          if (mode === "overflow-close") {
            // Release only after the fixture's first stdout write completes.
            await withinTest(
              awaitGateBeforeSettlement(control!.reached, command, "overflow writer did not start"),
              signal,
            ).finally(() => control!.unblock());
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

  it.for([
    { first: "refuse", second: "ready" },
    { first: "late-refuse", second: "ready" },
    { first: "refuse", second: "refuse" },
  ])(
    "allows one retry after $first, ending with $second",
    async ({ first, second }, { signal }) => {
      const control = await createGatewayControl();
      const { instance, readAttempts } = await createFakeGateway(first + "," + second + ",ready", {
        control,
      });
      const exited = observeGatewayExit(control, instance);
      const observeExit = control.observers.onLaunch;
      const children: NonNullable<typeof instance.child>[] = [];
      let previousOutputClosed = true;
      control.observers.onLaunch = () => {
        observeExit();
        const previous = children.at(-1);
        if (previous) {
          previousOutputClosed &&= previous.stdout.closed && previous.stderr.closed;
        }
        children.push(instance.child!);
      };
      const { restoreClock } = freezePolicyClock(signal);
      const startup = trackOperation(instance.startGateway());
      const outcome = startup.catch((error: unknown) => error);
      try {
        if (first === "late-refuse") {
          await Promise.race([exited, outcome]);
          await Promise.race([control.reached, outcome]);
          expect(instance.child?.stderr.closed).toBe(false);
          expect(instance.logs()).not.toContain(MIGRATION_CONVERGENCE_REFUSAL);
          await control.release();
        }
        if (second === "ready") {
          expect(await outcome).toBeUndefined();
          await expectReady(instance);
        } else {
          expect(String(await outcome)).toContain(
            "gateway exited before readiness (code=1 signal=null)",
          );
          expect(instance.child).toBeUndefined();
        }
        expect(await readAttempts()).toHaveLength(2);
        expect(previousOutputClosed).toBe(true);
        expect(children[0]!.pid).not.toBe(children[1]!.pid);
        expect(children[0]!.exitCode).toBe(1);
        expect(instance.logs().split(MIGRATION_CONVERGENCE_REFUSAL)).toHaveLength(
          second === "ready" ? 2 : 3,
        );
        expect(instance.logs().split(RESTART_MARKER)).toHaveLength(2);
        await instance.stopGateway();
        for (const child of children) {
          expect(child.stdout.closed && child.stderr.closed).toBe(true);
          expect(isProcessAlive(child.pid!)).toBe(false);
        }
      } finally {
        restoreClock();
        control.unblock();
        await outcome;
      }
    },
  );

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

  it.each(["joined", "timeout", "exception"] as const)(
    "joins Windows termination and sanitizes %s diagnostics",
    async (mode) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(createGatewayProcessState(), {
        pid: process.pid,
        kill: () => true,
        stdout,
        stderr,
      }) as unknown as Parameters<typeof testing.stopWindowsGatewayProcess>[0];
      const stopLog = testing.createBoundedStringLog();
      const observed = createDeferred();
      const now = Date.now.bind(Date);
      let elapsed = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
      const runTaskkill = vi.fn(() => {
        elapsed += 1_000;
        if (runTaskkill.mock.calls.length === 1) {
          setImmediate(() => {
            child.exitCode = 0;
            stdout.destroy();
            stderr.destroy();
            observed.resolve();
          });
        }
        if (mode === "exception") {
          throw Object.assign(new Error("private termination detail"), { code: "EACCES" });
        }
        return mode === "timeout" && runTaskkill.mock.calls.length === 2
          ? {
              status: null,
              signal: "SIGKILL" as const,
              error: Object.assign(new Error("private timeout detail"), { code: "ETIMEDOUT" }),
            }
          : { status: mode === "joined" ? 0 : 1, signal: null };
      });
      try {
        const stop = testing.stopWindowsGatewayProcess(
          child,
          Date.now() + 500,
          250,
          { runTaskkill },
          stopLog,
        );
        if (mode === "joined") {
          expect(await stop).toBe(true);
          expect(stdout.closed && stderr.closed).toBe(true);
          expect(stopLog).toEqual([]);
        } else {
          await expect(stop).rejects.toBeInstanceOf(Error);
          expect(stopLog).toHaveLength(1);
          const line = stopLog[0]!;
          const diagnostic = JSON.parse(
            line.slice("[openclaw-test-instance] Windows shutdown ".length),
          );
          expect(diagnostic.errorCode).toBe(
            mode === "exception" ? "EACCES" : "EPROCESSGROUP_CLEANUP_FAILED",
          );
          expect(diagnostic.taskkill.at(-1)).toMatchObject(
            mode === "exception"
              ? { threw: true, errorCode: "EACCES" }
              : { errorCode: "ETIMEDOUT" },
          );
          for (const attempt of diagnostic.taskkill) {
            expect(attempt.elapsedMs).toBeGreaterThanOrEqual(1_000);
          }
          expect(line).not.toContain("private");
          expect(Buffer.byteLength(line)).toBeLessThan(1_024);
        }
      } finally {
        await observed.promise;
        clock.mockRestore();
      }
    },
  );

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
        { chunks: ["😀a"], limit: 1, expected: "a" },
        { chunks: ["😀"], limit: 1, expected: "" },
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
      const result = testing
        .waitForGatewayReady(processState, [], [], 12345, timeout, fetchImpl, abort.signal, record)
        .catch((error: unknown) => error);
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
        lastProbe: { endpoint: "/startupz", startupStatus: "started" },
        lastFailedResponse: { startupStatus: "starting" },
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
            failing: [...allowed, ...Array<string>(16).fill(privateDetail)],
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
      { status: 502, body: "refusal", error: "invalid-json" },
      { status: 200, body: '{"ready":false}', ready: false },
      { status: 503, body: '{"ready":true}', ready: true },
      { status: 200, body: "{}" },
      { status: 503, body: "body-failed", error: "body-failed" },
      { status: undefined, body: "fetch-failed", error: "fetch-failed" },
    ])("retains sanitized $body failure evidence across later failures", async (failed) => {
      const secret = "synthetic-proxy-credential";
      const fetchImpl = createStalledReadinessFetch("headers")
        .mockResolvedValueOnce(jsonResponse({ ready: false }, 429))
        .mockImplementationOnce(async () => {
          if (failed.error === "fetch-failed") {
            throw new Error(secret);
          }
          const response = new Response(failed.body, {
            status: failed.status,
            headers: { "x-private": secret },
          });
          if (failed.error === "body-failed") {
            response.json = () => Promise.reject(new Error(secret));
          }
          return response;
        })
        .mockRejectedValueOnce(new Error(secret));
      const run = probe(fetchImpl, 79);
      const error = await run.done();
      const diagnostic = run.record.mock.calls[0]![0];
      expect(diagnostic.probes[1]).toMatchObject({
        phase: failed.error === "fetch-failed" ? "headers" : failed.error ? "body" : "complete",
        ...(failed.error ? { error: failed.error } : {}),
        ...(failed.ready === undefined ? {} : { ready: failed.ready }),
      });
      expect(readReadinessReceipt(error)).toMatchObject({
        attempts: 4,
        lastProbe: { phase: "headers", error: "timeout" },
        lastFailedResponse: {
          attempt: failed.status === undefined ? 1 : 2,
          status: failed.status ?? 429,
          ...(failed.status !== undefined && failed.error ? { error: failed.error } : {}),
          ...(failed.ready === undefined ? {} : { ready: failed.ready }),
        },
      });
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    });

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
        await run.done(15);
        const diagnostic = run.record.mock.calls[0]![0];
        expect(diagnostic).toMatchObject({
          outcome,
          lastProbe: { attempt: 2, phase: "body", status: 503 },
          lastFailedResponse: { attempt: 1, phase: "body", status: 502, error: "invalid-json" },
        });
        const retained = JSON.stringify(diagnostic);
        lateBody.resolve({ ready: false, failing: ["state-database"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.stringify(diagnostic)).toBe(retained);
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
        expect(readReadinessReceipt(error).lastProbe).toMatchObject({
          phase,
          error: exits ? "child-exit" : "timeout",
        });
        expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      },
    );
  });

  it("creates isolated config and spawn env without mutating process env", async () => {
    const previousHome = process.env.HOME;
    const inst = await createOpenClawTestInstance({
      name: "instance-unit",
      gatewayToken: "gateway-token",
      hookToken: "hook-token",
      config: { gateway: { bind: "loopback" } },
      env: { OPENCLAW_SKIP_CRON: "0" },
    });

    try {
      expect(process.env.HOME).toBe(previousHome);
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
