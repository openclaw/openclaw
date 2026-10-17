import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { DebugProxyCliStore } from "../proxy-capture/store.types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { waitForSignalExitBarriers } from "./signal-exit-barrier.js";

type SessionStore = Pick<DebugProxyCliStore, "upsertSession" | "endSession">;
const { acquireStore, spawnChild, stopServer, startServer, ensureCa } = vi.hoisted(() => ({
  acquireStore: vi.fn<() => Promise<{ store: SessionStore; release: () => Promise<void> }>>(),
  spawnChild: vi.fn<
    (
      argv: string[],
      options: { cancelSignal?: AbortSignal },
    ) => Promise<{
      exitCode?: number;
      signal?: NodeJS.Signals;
      failed?: boolean;
    }>
  >(),
  stopServer: vi.fn<() => Promise<void>>(),
  startServer: vi.fn(),
  ensureCa: vi.fn(),
}));

vi.mock("../process/exec-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec-spawn.js")>()),
  spawnCommand: spawnChild,
}));
vi.mock("../proxy-capture/store.async.js", () => ({
  acquireDebugProxyCaptureStoreAsync: acquireStore,
}));
vi.mock("../proxy-capture/proxy-server.js", () => ({
  startDebugProxyServer: startServer,
}));
vi.mock("./local-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-state-owner.js")>()),
  runWithLocalStateOwner: ({
    runLocal,
  }: {
    runLocal: (scope: { env: NodeJS.ProcessEnv; assertCurrent(): void }) => unknown;
  }) => runLocal({ env: {}, assertCurrent() {} }),
}));
vi.mock("../proxy-capture/ca.js", () => ({ ensureDebugProxyCa: ensureCa }));
vi.mock("../proxy-capture/coverage.js", () => ({ buildDebugProxyCoverageReport: vi.fn() }));
// mock-isolation: Proxy cleanup fixtures use empty config without preparing a real config owner.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("../infra/net/proxy/proxy-validation.js", () => ({ runProxyValidation: vi.fn() }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ environment: {} }),
}));
vi.mock("../proxy-capture/env.js", () => ({
  resolveDebugProxySettings: () => ({ sessionId: "fixture", certDir: "fixture-certs" }),
  applyDebugProxyEnv: () => ({}),
}));

import { runDebugProxyRunCommand, runDebugProxyStartCommand } from "./proxy-cli.runtime.js";

const savedExitCode = process.exitCode;
beforeEach(() => {
  process.exitCode = undefined;
  startServer.mockResolvedValue({
    proxyUrl: "http://127.0.0.1:7799",
    captureEnv: { OPENCLAW_DEBUG_PROXY_URL: "http://capture.invalid:7799" },
    stop: stopServer,
  });
  ensureCa.mockResolvedValue({ certPath: "fixture-cert.pem" });
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.resetAllMocks();
});

function installCapture(
  endSession = vi.fn<DebugProxyCliStore["endSession"]>(async () => {}),
  release = vi.fn(async () => {}),
) {
  const upsertSession = vi.fn<DebugProxyCliStore["upsertSession"]>(async () => {});
  const store: SessionStore = { upsertSession, endSession };
  acquireStore.mockResolvedValue({ store, release });
  return { store, upsertSession, endSession, release };
}
const runChild = () => runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
function expectCleanupCalls(count: number, ...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}
function pendingChild() {
  const launched = createDeferred<AbortSignal>();
  const closed = createDeferred<{ signal: NodeJS.Signals; failed: boolean }>();
  const child = Object.assign(closed.promise, { kill: vi.fn((_signal: NodeJS.Signals) => true) });
  spawnChild.mockImplementation((_argv, { cancelSignal }) => {
    if (!cancelSignal) {
      throw new Error("Proxy child has no cancellation owner");
    }
    launched.resolve(cancelSignal);
    return child;
  });
  return { launched, closed, child };
}
const rejectCleanup = (order: string[], name: string, error: Error) => async () => {
  order.push(`${name}:start`);
  await Promise.resolve();
  order.push(`${name}:rejected`);
  throw error;
};
function expectAggregate(error: unknown, expected: Error[]) {
  if (!(error instanceof AggregateError)) {
    throw new Error("Expected aggregate startup or cleanup failure", { cause: error });
  }
  expect(error.errors).toHaveLength(expected.length);
  for (const [index, entry] of expected.entries()) {
    expect(error.errors[index]).toBe(entry);
  }
}

it.each([
  { command: "start", stage: "acquire" },
  { command: "start", stage: "upsert" },
  { command: "start", stage: "ca" },
  { command: "start", stage: "server" },
  { command: "run", stage: "upsert" },
  { command: "run", stage: "server" },
  { command: "run", stage: "child-success" },
  { command: "run", stage: "child-error" },
] as const)(
  "preserves failures and settles cleanup during $command/$stage",
  async ({ command, stage }) => {
    const startupFailure = new Error(`synthetic ${stage} failure`);
    const sessionFailure = new Error("synthetic capture finalization failure");
    const releaseFailure = new Error("synthetic release failure");
    const stopFailure = new Error("synthetic server stop failure");
    const order: string[] = [];
    const childDone = stage === "child-success" || stage === "child-error";
    const endSession = vi.fn<DebugProxyCliStore["endSession"]>(
      rejectCleanup(order, "session", sessionFailure),
    );
    const release = vi.fn(rejectCleanup(order, "release", releaseFailure));
    const { upsertSession } = installCapture(endSession, release);
    if (stage === "child-success" || stage === "child-error") {
      stopServer.mockImplementation(rejectCleanup(order, "stop", stopFailure));
      if (stage === "child-error") {
        spawnChild.mockRejectedValue(startupFailure);
      } else {
        spawnChild.mockResolvedValue({ exitCode: 0 });
      }
    } else {
      ({ acquire: acquireStore, upsert: upsertSession, ca: ensureCa, server: startServer })[
        stage
      ].mockRejectedValue(startupFailure);
    }

    const failure = await (command === "start" ? runDebugProxyStartCommand({}) : runChild()).catch(
      (error: unknown) => error,
    );

    const acquired = stage !== "acquire";
    expect(order).toEqual([
      ...(childDone ? ["stop:start", "stop:rejected"] : []),
      ...(acquired
        ? ["session:start", "session:rejected", "release:start", "release:rejected"]
        : []),
    ]);
    expectCleanupCalls(childDone ? 1 : 0, stopServer, spawnChild);
    expect(endSession).toHaveBeenCalledTimes(acquired ? 1 : 0);
    expect(release).toHaveBeenCalledTimes(acquired ? 1 : 0);
    if (!acquired) {
      expect(failure).toBe(startupFailure);
      return;
    }
    if (childDone) {
      expect(endSession).toHaveBeenCalledExactlyOnceWith(upsertSession.mock.calls[0]![0].id);
    }
    expectAggregate(failure, [
      ...(stage === "child-success" ? [] : [startupFailure]),
      ...(childDone ? [stopFailure] : []),
      sessionFailure,
      releaseFailure,
    ]);
  },
);

it.each([
  { signal: "SIGINT" as const, exitCode: 130 },
  { signal: "SIGTERM" as const, exitCode: 143 },
])(
  "retains child close and capture custody after parent-only $signal",
  async ({ signal, exitCode }) => {
    const { launched, closed, child } = pendingChild();
    const releasing = createDeferred();
    const retired = createDeferred();
    const previousListeners = process.listeners(signal);
    const before = new Set(previousListeners);
    const order: string[] = [];
    child.kill.mockImplementation(() => {
      order.push("signal");
      return true;
    });
    const { store } = installCapture(
      vi.fn<DebugProxyCliStore["endSession"]>(async () => {
        order.push("session");
      }),
      vi.fn(async () => {
        order.push("release");
        releasing.resolve();
        await retired.promise;
      }),
    );
    stopServer.mockImplementation(async () => {
      order.push("stop");
    });
    const command = runChild();
    let onSignal: (typeof previousListeners)[number] | undefined;
    try {
      await awaitGateBeforeSettlement(launched.promise, command, "Proxy child was not launched");
      onSignal = process.listeners(signal).find((listener) => !before.has(listener));
      expect(onSignal).toBeDefined();
      onSignal?.(signal);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
      expect(order).toEqual(["signal"]);
      expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ captureStore: store }));
      expect(spawnChild).toHaveBeenCalledWith(
        ["synthetic-child"],
        expect.objectContaining({
          stdio: "inherit",
          env: { OPENCLAW_DEBUG_PROXY_URL: "http://capture.invalid:7799" },
          reject: false,
        }),
      );
      closed.resolve({ signal, failed: true });
      await awaitGateBeforeSettlement(releasing.promise, command, "Capture lease was not released");
      expect(order).toEqual(["signal", "stop", "session", "release"]);
      expect(process.listeners(signal)).toContain(onSignal);
      onSignal?.(signal);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      closed.resolve({ signal, failed: true });
      retired.resolve();
      await command;
    }
    expect(process.exitCode).toBe(exitCode);
    expect(process.listeners(signal)).not.toContain(onSignal);
  },
);

it.each(["capture", "command"] as const)(
  "joins the child before capture cleanup when the %s owner cancels",
  async (owner) => {
    const { launched, closed } = pendingChild();
    const work = new AsyncWorkScope();
    const { endSession, release } = installCapture();
    const command = work.track(runChild);
    let drain: Promise<void> | undefined;
    try {
      const signal = await awaitGateBeforeSettlement(
        launched.promise,
        command,
        "Proxy child was not launched",
      );
      if (owner === "capture") {
        drain = waitForSignalExitBarriers();
      } else {
        work.beginClose();
      }
      expect(signal.aborted).toBe(true);
      expectCleanupCalls(0, stopServer, endSession, release);
    } finally {
      closed.resolve({ signal: "SIGTERM", failed: true });
      await command;
      await drain;
      await work.drain();
    }
    expectCleanupCalls(1, stopServer, endSession, release);
    expect(process.exitCode).toBe(143);
  },
);
