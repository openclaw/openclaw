import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AsyncDebugProxyCaptureStore } from "../proxy-capture/store.types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { waitForSignalExitBarriers } from "./signal-exit-barrier.js";

const { acquireStore, spawnChild, stopServer, startServer, ensureCa, captureSettings } = vi.hoisted(
  () => ({
    acquireStore:
      vi.fn<() => Promise<{ store: AsyncDebugProxyCaptureStore; release: () => Promise<void> }>>(),
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
    captureSettings: { enabled: false },
  }),
);

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
vi.mock("../config/config.js", () => ({ getRuntimeConfig: vi.fn() }));
vi.mock("../infra/net/proxy/proxy-validation.js", () => ({ runProxyValidation: vi.fn() }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ environment: {} }),
}));
vi.mock("../proxy-capture/env.js", () => ({
  resolveDebugProxySettings: () => ({
    enabled: captureSettings.enabled,
    required: false,
    sessionId: "fixture",
    sourceProcess: "fixture",
    dbPath: "fixture.sqlite",
    blobDir: "fixture-blobs",
    certDir: "fixture-certs",
  }),
  applyDebugProxyEnv: () => ({}),
}));

import { runDebugProxyRunCommand, runDebugProxyStartCommand } from "./proxy-cli.runtime.js";

const savedExitCode = process.exitCode;
beforeEach(() => {
  captureSettings.enabled = false;
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

function createStore(
  upsertSession: AsyncDebugProxyCaptureStore["upsertSession"],
  endSession: AsyncDebugProxyCaptureStore["endSession"],
): AsyncDebugProxyCaptureStore {
  return {
    dbPath: "fixture.sqlite",
    isClosed: false,
    upsertSession,
    endSession,
    persistPayload: async (data, contentType) => ({
      blobId: "fixture-blob",
      sha256: "fixture-hash",
      encoding: "gzip",
      sizeBytes: data.length,
      contentType,
    }),
    recordEvent: async () => {},
    recordEventWithPayload: async () => {},
    listSessions: async () => [],
    getSessionEvents: async () => [],
    summarizeSessionCoverage: async (sessionId) => ({
      sessionId,
      totalEvents: 0,
      unlabeledEventCount: 0,
      providers: [],
      apis: [],
      models: [],
      hosts: [],
      localPeers: [],
    }),
    readBlob: async () => null,
    queryPreset: async () => [],
    deleteSessions: async () => ({ sessions: 0, events: 0, blobs: 0 }),
    purgeAll: async () => ({ sessions: 0, events: 0, blobs: 0 }),
    close: async () => {},
  };
}

describe("proxy command cleanup errors", () => {
  it.each([
    { command: "start", enabled: true, stage: "acquire" },
    { command: "start", enabled: true, stage: "ca" },
    { command: "start", enabled: true, stage: "server" },
    { command: "start", enabled: false, stage: "upsert" },
    { command: "start", enabled: false, stage: "ca" },
    { command: "start", enabled: false, stage: "server" },
    { command: "run", enabled: false, stage: "upsert" },
    { command: "run", enabled: false, stage: "server" },
  ] as const)(
    "settles admitted cleanup after $command fails during $stage (capture enabled: $enabled)",
    async ({ command, enabled, stage }) => {
      captureSettings.enabled = enabled;
      const startupFailure = new Error(`synthetic ${stage} failure`);
      const sessionFailure = new Error("synthetic capture finalization failure");
      const releaseFailure = new Error("synthetic release failure");
      const order: string[] = [];
      const closeSession = async () => {
        order.push("session:start");
        await Promise.resolve();
        order.push("session:rejected");
        throw sessionFailure;
      };
      const endSession = vi.fn<AsyncDebugProxyCaptureStore["endSession"]>(closeSession);
      const upsertSession = vi.fn<AsyncDebugProxyCaptureStore["upsertSession"]>(async () => {});
      const release = vi.fn(async () => {
        order.push("release");
        throw releaseFailure;
      });
      acquireStore.mockResolvedValue({ store: createStore(upsertSession, endSession), release });
      const failingOperation = {
        acquire: acquireStore,
        upsert: upsertSession,
        ca: ensureCa,
        server: startServer,
      }[stage];
      failingOperation.mockRejectedValue(startupFailure);

      const failure = await (
        command === "start"
          ? runDebugProxyStartCommand({})
          : runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] })
      ).catch((error: unknown) => error);

      const acquired = stage !== "acquire";
      expect(order).toEqual(acquired ? ["session:start", "session:rejected", "release"] : []);
      expect(stopServer).not.toHaveBeenCalled();
      expect(spawnChild).not.toHaveBeenCalled();
      expect(endSession).toHaveBeenCalledTimes(acquired ? 1 : 0);
      expect(release).toHaveBeenCalledTimes(acquired ? 1 : 0);
      if (!acquired) {
        expect(failure).toBe(startupFailure);
        return;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected aggregate startup and cleanup failure");
      }
      expect(failure.errors).toEqual([startupFailure, sessionFailure, releaseFailure]);
    },
  );

  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])(
    "retains child close and capture custody after parent-only $signal",
    async ({ signal, exitCode }) => {
      const launched = createDeferred();
      const closed = createDeferred<{ signal: NodeJS.Signals; failed: boolean }>();
      const releasing = createDeferred();
      const retired = createDeferred();
      const previousListeners = process.listeners(signal);
      const before = new Set(previousListeners);
      const order: string[] = [];
      const child = Object.assign(closed.promise, {
        kill: vi.fn(() => {
          order.push("signal");
          return true;
        }),
      });
      spawnChild.mockImplementation(() => {
        launched.resolve();
        return child;
      });
      const store = createStore(
        async () => {},
        async () => {
          order.push("session");
        },
      );
      acquireStore.mockResolvedValue({
        store,
        release: async () => {
          order.push("release");
          releasing.resolve();
          await retired.promise;
        },
      });
      stopServer.mockImplementation(async () => {
        order.push("stop");
      });
      const command = runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
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
        await awaitGateBeforeSettlement(
          releasing.promise,
          command,
          "Capture lease was not released",
        );
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
      const launched = createDeferred<AbortSignal>();
      const closed = createDeferred<{ signal: NodeJS.Signals; failed: boolean }>();
      const work = new AsyncWorkScope();
      const endSession = vi.fn(async () => {});
      const release = vi.fn(async () => {});
      acquireStore.mockResolvedValue({
        store: createStore(async () => {}, endSession),
        release,
      });
      spawnChild.mockImplementation((_argv, options) => {
        if (!options.cancelSignal) {
          throw new Error("Proxy child has no cancellation owner");
        }
        launched.resolve(options.cancelSignal);
        return closed.promise;
      });
      const command = work.track(() =>
        runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] }),
      );
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
        expect(stopServer).not.toHaveBeenCalled();
        expect(endSession).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
      } finally {
        closed.resolve({ signal: "SIGTERM", failed: true });
        await command;
        await drain;
        await work.drain();
      }
      expect(stopServer).toHaveBeenCalledOnce();
      expect(endSession).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(143);
    },
  );

  it.each(["success", "error"] as const)(
    "preserves every cleanup error and settles cleanup in order after child %s",
    async (outcome) => {
      const childFailure = new Error("synthetic child failure");
      const stopFailure = new Error("synthetic server stop failure");
      const endFailure = new Error("synthetic session end failure");
      const releaseFailure = new Error("synthetic lease release failure");
      const order: string[] = [];
      const rejectCleanup = (name: string, error: Error) => async () => {
        order.push(`${name}:start`);
        await Promise.resolve();
        order.push(`${name}:rejected`);
        throw error;
      };
      const upsertSession = vi.fn<AsyncDebugProxyCaptureStore["upsertSession"]>(async () => {});
      const endSession = vi.fn<AsyncDebugProxyCaptureStore["endSession"]>(
        rejectCleanup("endSession", endFailure),
      );
      const release = vi.fn(rejectCleanup("release", releaseFailure));
      const store = createStore(upsertSession, endSession);
      acquireStore.mockResolvedValue({ store, release });
      stopServer.mockImplementation(rejectCleanup("stop", stopFailure));
      spawnChild.mockImplementation(async () => {
        if (outcome === "error") {
          throw childFailure;
        }
        return { exitCode: 0 };
      });

      let failure: unknown;
      try {
        await runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
      } catch (error) {
        failure = error;
      }

      expect(order).toEqual([
        "stop:start",
        "stop:rejected",
        "endSession:start",
        "endSession:rejected",
        "release:start",
        "release:rejected",
      ]);
      expect(stopServer).toHaveBeenCalledTimes(1);
      expect(endSession).toHaveBeenCalledExactlyOnceWith(upsertSession.mock.calls[0]![0].id);
      expect(release).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected aggregate cleanup failure");
      }
      const expected = [
        ...(outcome === "error" ? [childFailure] : []),
        stopFailure,
        endFailure,
        releaseFailure,
      ];
      expect(failure.errors).toHaveLength(expected.length);
      for (const [index, error] of expected.entries()) {
        expect(failure.errors[index]).toBe(error);
      }
    },
  );
});
