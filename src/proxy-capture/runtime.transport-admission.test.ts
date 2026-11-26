import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { fetchWithSsrFGuard, type GuardedFetchResult } from "../infra/net/fetch-guard.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerLease } from "../state/openclaw-state-worker-store.js";
import { resolveDebugProxySettings } from "./env.js";
import { withDeferredDebugProxyCapture } from "./runtime-deferral.js";
import {
  captureWsEventAsync,
  finalizeDebugProxyCapture,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCapture,
  initializeDebugProxyCaptureAsync,
  prepareHttpCaptureForTransport,
} from "./runtime.js";

const control = vi.hoisted(() => ({
  scope: undefined as OpenClawDatabaseMaintenanceScope | undefined,
}));
const captureUrl = "https://synthetic.invalid/capture";

const createWorkerLease = vi.hoisted(() =>
  vi.fn<typeof import("../state/openclaw-state-worker-store.js").createOpenClawStateWorkerLease>(),
);

vi.mock("../state/openclaw-state-worker-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-worker-store.js")>()),
  createOpenClawStateWorkerLease: createWorkerLease,
}));

vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  getOpenClawDatabaseMaintenanceScope: () => control.scope,
}));

vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: {
      coordinationKey: "synthetic",
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  }),
}));

afterEach(() => {
  control.scope = undefined;
  createWorkerLease.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubWorker(ready?: Promise<void>, acquired?: () => void) {
  const committed = vi.fn<OpenClawStateWorkerLease["execute"]>().mockResolvedValue(undefined);
  createWorkerLease.mockImplementation((_context, finalize) => {
    const scope: Pick<OpenClawStateWorkerLease, "execute"> = {
      execute: ready
        ? (command, options) => ready.then(() => committed(command, options))
        : committed,
    };
    let closing: Promise<void> | undefined;
    acquired?.();
    return {
      ready: ready ?? Promise.resolve(),
      execute: scope.execute,
      runOperation: async (operation) => await operation(scope),
      release: () => (closing ??= (ready ?? Promise.resolve()).then(() => finalize?.(scope))),
      retire: async () => {},
    };
  });
  return committed;
}

async function expectDiagnostic(finalize: () => void | Promise<void>, failure: Error) {
  let diagnostic: unknown;
  try {
    await finalize();
  } catch (error) {
    diagnostic = error;
  }
  expect(collectNestedErrorCandidates(diagnostic)).toContain(failure);
}

it.each([
  ["selection", "success"],
  ["continuation", "failure"],
  ["ready", "success"],
  ["reservation", "failure"],
] as const)(
  "preserves transport %s/%s across capture admission failure",
  async (phase, outcome) => {
    stubGuardedCaptureEnv(`admission-${phase}`);
    const settings = resolveDebugProxySettings();
    const failure = new Error("synthetic capture admission rejected");
    const transportFailure = new Error("synthetic transport rejection");
    const response = new Response("transport succeeded", {
      headers: { "x-fixture": "transport-response" },
    });
    let refuse = phase === "selection";
    const transport = vi.fn<typeof fetch>(async () => {
      refuse = true;
      if (outcome === "failure") {
        throw transportFailure;
      }
      return response;
    });
    const target: typeof globalThis = { ...globalThis, fetch: transport };
    const store = { upsertSession: vi.fn(), endSession: vi.fn(), recordEvent: vi.fn() };
    const deps = { getStore: () => store, fetchTarget: target };
    const guarded = phase === "ready" || phase === "reservation";
    if (guarded) {
      createWorkerLease.mockImplementation(() => {
        if (phase === "reservation") {
          throw failure;
        }
        const fail = async () => {
          throw failure;
        };
        return {
          ready: Promise.reject(failure),
          execute: fail,
          runOperation: fail,
          release: async () => {},
          retire: async () => {},
        };
      });
    } else {
      initializeDebugProxyCapture("fixture", settings, deps);
      control.scope = createOpenClawDatabaseMaintenanceScope();
      vi.spyOn(control.scope, "assertAdmission").mockImplementation(() => {
        if (refuse) {
          throw failure;
        }
      });
    }
    const finalize = () =>
      guarded
        ? finalizeDebugProxyCaptureAsync(settings)
        : finalizeDebugProxyCapture(settings, deps);
    let result: GuardedFetchResult | undefined;
    try {
      const pending = guarded
        ? fetchWithSsrFGuard({ url: captureUrl, fetchImpl: transport }).then((value) => {
            result = value;
            return value.response;
          })
        : target.fetch(captureUrl);
      try {
        if (outcome === "success") {
          const received = await pending;
          expect(received).toBe(response);
          expect(await received.text()).toBe("transport succeeded");
        } else {
          await expect(pending).rejects.toBe(transportFailure);
        }
      } finally {
        await result?.release();
      }
      if (!guarded) {
        expect(store.recordEvent).not.toHaveBeenCalled();
      }
      await expectDiagnostic(finalize, failure);
      if (!guarded) {
        expect(store.endSession).toHaveBeenCalledOnce();
      }
    } finally {
      const scope = control.scope;
      control.scope = undefined;
      await Promise.resolve()
        .then(finalize)
        .catch(() => undefined);
      await scope?.close();
    }
  },
);

function stubGuardedCaptureEnv(sessionId: string) {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", sessionId);
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic");
  for (const key of [
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, undefined);
  }
}

it("returns owner admission failure as an observed rejecting Promise", async () => {
  stubGuardedCaptureEnv("owner-admission");
  const admissionFailure = new Error("synthetic capture admission rejected");
  control.scope = createOpenClawDatabaseMaintenanceScope();
  vi.spyOn(control.scope, "assertAdmission").mockImplementation(() => {
    throw admissionFailure;
  });
  try {
    const result = captureWsEventAsync({
      url: "wss://synthetic.invalid/capture",
      direction: "outbound",
      kind: "ws-frame",
      flowId: "fixture",
      payload: "fixture",
    });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(admissionFailure);
  } finally {
    const scope = control.scope;
    control.scope = undefined;
    await scope.close();
  }
});

it.each(["fresh", "cached-worker", "saved-fetch"] as const)(
  "defers %s capture until the update owner releases it",
  async (mode) => {
    stubGuardedCaptureEnv(`deferred-${mode}`);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_REQUIRE", "1");
    const settings = resolveDebugProxySettings();
    const committed = stubWorker();
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = { upsertSession: vi.fn(), endSession: vi.fn(), recordEvent: vi.fn() };
    const target: typeof globalThis = { ...globalThis, fetch: transport };
    const deps = {
      getStore: vi.fn(() => store),
      persistEventPayload: () => ({}),
      fetchTarget: target,
    };
    const params = { url: captureUrl, method: "GET", error: new Error("transport diagnostic") };
    let exercise: () => Promise<void>;
    if (mode === "saved-fetch") {
      initializeDebugProxyCapture("fixture", settings, deps);
      const savedFetch = target.fetch;
      exercise = async () => {
        expect((await savedFetch(params.url)).status).toBe(204);
      };
    } else if (mode === "cached-worker") {
      await initializeDebugProxyCaptureAsync("fixture", settings, { fetchTarget: target });
      const cached = prepareHttpCaptureForTransport()!;
      exercise = () => cached(params);
    } else {
      exercise = async () => {
        await initializeDebugProxyCaptureAsync("fixture", settings, { fetchTarget: target });
        const result = await fetchWithSsrFGuard({ url: params.url, fetchImpl: transport });
        try {
          expect(result.response.status).toBe(204);
        } finally {
          await result.release();
          await finalizeDebugProxyCaptureAsync(settings);
        }
      };
    }
    const writes = [committed, createWorkerLease, store.upsertSession, store.recordEvent];
    const clearWrites = () => writes.forEach((write) => write.mockClear());
    const expectNoWrites = () => writes.forEach((write) => expect(write).not.toHaveBeenCalled());
    const expectWrites = () => {
      expect(committed.mock.calls.length + store.recordEvent.mock.calls.length).toBeGreaterThan(0);
    };
    const check = async (released = false) => {
      await exercise();
      (released ? expectWrites : expectNoWrites)();
    };
    let continueAfterClose = createDeferredCore();
    let late: Promise<void> | undefined;
    clearWrites();
    try {
      await withDeferredDebugProxyCapture(async (resume) => {
        await check();
        await withDeferredDebugProxyCapture(async (resumeNested) => {
          await check();
          resumeNested();
          await check(true);
        });
        clearWrites();
        await check(true);
        clearWrites();
        late = continueAfterClose.promise.then(async () => {
          resume();
          await exercise();
        });
      });
      continueAfterClose.resolve();
      await late;
      expectWrites();
      clearWrites();
      continueAfterClose = createDeferredCore();
      await withDeferredDebugProxyCapture(async (resume) => {
        await check();
        late = continueAfterClose.promise.then(async () => {
          resume();
          await withDeferredDebugProxyCapture(async (resumeNested) => {
            resumeNested();
            await exercise();
          });
        });
      });
      continueAfterClose.resolve();
      await late;
      expectNoWrites();
    } finally {
      continueAfterClose.resolve();
      await late;
      await finalizeDebugProxyCaptureAsync(settings, { fetchTarget: target });
      finalizeDebugProxyCapture(settings, deps);
    }
  },
);

it.each(["success", "failure"] as const)(
  "returns guarded transport %s before cold capture readiness settles",
  async (outcome) => {
    stubGuardedCaptureEnv(`guarded-cold-${outcome}`);
    const settings = resolveDebugProxySettings();
    const ready = createDeferredCore();
    const acquired = createDeferredCore();
    const committed = stubWorker(ready.promise, acquired.resolve);
    const transportFailure = new Error("synthetic cold-readiness transport rejection");
    const response = new Response(null, { status: 204 });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    if (outcome === "failure") {
      transport.mockRejectedValue(transportFailure);
    }
    const succeeded = vi.fn<(value: GuardedFetchResult) => void>();
    const failed = vi.fn<(error: unknown) => void>();
    const operation = fetchWithSsrFGuard({
      url: captureUrl,
      fetchImpl: transport,
      init: { method: "POST", body: Buffer.from("cold request") },
      capture: { flowId: "cold-flow" },
    }).then(succeeded, failed);
    try {
      await acquired.promise;
      // Drain this turn's ready work without resolving the worker gate or polling.
      await nextEventLoopTurn();
      expect(transport).toHaveBeenCalledTimes(1);
      expect([succeeded.mock.calls.length, failed.mock.calls.length]).toEqual(
        outcome === "success" ? [1, 0] : [0, 1],
      );
      if (outcome === "success") {
        expect(succeeded.mock.calls[0]?.[0].response).toBe(response);
        expect(response.status).toBe(204);
      } else {
        expect(failed.mock.calls[0]?.[0]).toBe(transportFailure);
      }
      expect(committed).not.toHaveBeenCalled();
      ready.resolve();
      await operation;
      await finalizeDebugProxyCaptureAsync(settings);
      const commands = committed.mock.calls.map(([command]) => command);
      expect(commands.pop()).toEqual({
        type: "capture.endSession",
        input: { sessionId: settings.sessionId, endedAt: expect.any(Number) },
      });
      const payloadCommand = (event: Record<string, unknown>, data: Buffer) => ({
        type: "capture.recordEventWithPayload",
        input: { event: { ...event, flowId: "cold-flow" }, payload: { data } },
      });
      expect(commands).toMatchObject(
        outcome === "success"
          ? [
              payloadCommand({ kind: "request" }, Buffer.from("cold request")),
              payloadCommand({ kind: "response", status: 204 }, Buffer.alloc(0)),
            ]
          : [
              {
                type: "capture.recordEvent",
                input: { kind: "error", flowId: "cold-flow", errorText: transportFailure.message },
              },
            ],
      );
    } finally {
      ready.resolve();
      await operation;
      try {
        await succeeded.mock.calls[0]?.[0].release();
      } finally {
        await finalizeDebugProxyCaptureAsync(settings);
      }
    }
  },
);
