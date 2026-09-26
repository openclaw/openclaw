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
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import {
  finalizeDebugProxyCapture,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCapture,
} from "./runtime.js";

const control = vi.hoisted(() => ({
  scope: undefined as OpenClawDatabaseMaintenanceScope | undefined,
}));

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

it.each(
  (["selection", "continuation"] as const).flatMap((phase) =>
    (["success", "failure"] as const).map((outcome) => ({ phase, outcome })),
  ),
)(
  "keeps transport $outcome independent of $phase capture admission and retains the diagnostic",
  async ({ phase, outcome }) => {
    const admissionFailure = new Error("synthetic admission refusal");
    const transportFailure = new Error("synthetic transport rejection");
    let refuse = phase === "selection";
    const transport = vi.fn(async () => {
      refuse = true;
      if (outcome === "failure") {
        throw transportFailure;
      }
      return new Response("transport succeeded");
    });
    const target: typeof globalThis = { ...globalThis, fetch: transport };
    const store = { upsertSession: vi.fn(), endSession: vi.fn(), recordEvent: vi.fn() };
    const deps = { getStore: () => store, fetchTarget: target };
    const settings: DebugProxySettings = {
      enabled: true,
      required: false,
      dbPath: "/synthetic/capture.sqlite",
      blobDir: "/synthetic/blobs",
      certDir: "/synthetic/certs",
      sessionId: "transport-admission",
      sourceProcess: "fixture",
    };
    initializeDebugProxyCapture("fixture", settings, deps);
    control.scope = createOpenClawDatabaseMaintenanceScope();
    vi.spyOn(control.scope, "assertAdmission").mockImplementation(() => {
      if (refuse) {
        throw admissionFailure;
      }
    });
    const own = vi.spyOn(control.scope, "own");
    try {
      const result = target.fetch("https://synthetic.invalid/capture");
      if (outcome === "success") {
        expect(await (await result).text()).toBe("transport succeeded");
      } else {
        await expect(result).rejects.toBe(transportFailure);
      }
      expect(transport).toHaveBeenCalledTimes(1);
      expect(own).toHaveBeenCalledTimes(phase === "selection" ? 0 : 1);
      expect(store.recordEvent).not.toHaveBeenCalled();
      let diagnostic: unknown;
      try {
        finalizeDebugProxyCapture(settings, deps);
      } catch (error) {
        diagnostic = error;
      }
      expect(collectNestedErrorCandidates(diagnostic)).toContain(admissionFailure);
      expect(store.endSession).toHaveBeenCalledOnce();
    } finally {
      const scope = control.scope;
      control.scope = undefined;
      finalizeDebugProxyCapture(settings, deps);
      await scope.close();
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

it.each(
  (["ready", "reservation"] as const).flatMap((failureKind) =>
    (["success", "failure"] as const).map((outcome) => ({ failureKind, outcome })),
  ),
)(
  "keeps guarded transport $outcome independent of $failureKind capture preparation failure",
  async ({ failureKind, outcome }) => {
    const preparationFailure = new Error("synthetic capture preparation rejected");
    const transportFailure = new Error("synthetic guarded transport rejected");
    stubGuardedCaptureEnv(`guarded-preparation-${failureKind}-${outcome}`);
    createWorkerLease.mockImplementation(() => {
      if (failureKind === "reservation") {
        throw preparationFailure;
      }
      const lease: OpenClawStateWorkerLease = {
        ready: Promise.reject(preparationFailure),
        execute: async () => {
          throw preparationFailure;
        },
        runOperation: async () => {
          throw preparationFailure;
        },
        release: async () => {},
        retire: async () => {},
      };
      return lease;
    });
    const settings = resolveDebugProxySettings();
    const transport = vi.fn<typeof fetch>(async () => {
      if (outcome === "failure") {
        throw transportFailure;
      }
      return new Response("guarded transport succeeded", {
        status: 200,
        headers: { "x-fixture": "transport-response" },
      });
    });
    try {
      const pending = fetchWithSsrFGuard({
        url: "https://synthetic.invalid/capture-preparation",
        fetchImpl: transport,
      });
      if (outcome === "success") {
        const result = await pending;
        try {
          expect(result.response.status).toBe(200);
          expect(result.response.headers.get("x-fixture")).toBe("transport-response");
          expect(await result.response.text()).toBe("guarded transport succeeded");
        } finally {
          await result.release();
        }
      } else {
        await expect(pending).rejects.toBe(transportFailure);
      }
      expect(transport).toHaveBeenCalledTimes(1);
      expect(createWorkerLease).toHaveBeenCalledTimes(1);
      let diagnostic: unknown;
      try {
        await finalizeDebugProxyCaptureAsync(settings);
      } catch (error) {
        diagnostic = error;
      }
      expect(collectNestedErrorCandidates(diagnostic)).toContain(preparationFailure);
    } finally {
      // The controlled capture diagnostic must not mask a failed transport assertion.
      await finalizeDebugProxyCaptureAsync(settings).catch(() => undefined);
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
    const committed = vi.fn<OpenClawStateWorkerLease["execute"]>().mockResolvedValue(undefined);
    createWorkerLease.mockImplementation((_context, finalize) => {
      const scope: Pick<OpenClawStateWorkerLease, "execute"> = {
        execute: (command, options) => ready.promise.then(() => committed(command, options)),
      };
      let closing: Promise<void> | undefined;
      const lease: OpenClawStateWorkerLease = {
        ready: ready.promise,
        execute: scope.execute,
        runOperation: async (operation) => await operation(scope),
        release: () =>
          (closing ??= ready.promise.then(async () => {
            await finalize?.(scope);
          })),
        retire: async () => {},
      };
      acquired.resolve();
      return lease;
    });
    const transportFailure = new Error("synthetic cold-readiness transport rejection");
    const response = new Response(null, { status: 204 });
    const transport = vi.fn<typeof fetch>(async () => {
      if (outcome === "failure") {
        throw transportFailure;
      }
      return response;
    });
    let completed:
      | { kind: "success"; value: GuardedFetchResult }
      | { kind: "failure"; error: unknown }
      | undefined;
    const operation = fetchWithSsrFGuard({
      url: "https://synthetic.invalid/cold-capture",
      fetchImpl: transport,
      init: { method: "POST", body: Buffer.from("cold request") },
      capture: { flowId: "cold-flow" },
    }).then(
      (value) => {
        completed = { kind: "success", value };
      },
      (error: unknown) => {
        completed = { kind: "failure", error };
      },
    );
    try {
      await acquired.promise;
      // Drain this turn's ready work without resolving the worker gate or polling.
      await nextEventLoopTurn();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(completed).toBeDefined();
      if (!completed) {
        throw new Error("Transport did not settle before worker readiness");
      }
      if (outcome === "success") {
        expect(completed.kind).toBe("success");
        if (completed.kind !== "success") {
          throw completed.error;
        }
        expect(completed.value.response).toBe(response);
        expect(completed.value.response.status).toBe(204);
      } else {
        expect(completed.kind).toBe("failure");
        if (completed.kind !== "failure") {
          throw new Error("Expected transport rejection");
        }
        expect(completed.error).toBe(transportFailure);
      }
      expect(committed).not.toHaveBeenCalled();
      ready.resolve();
      await operation;
      await finalizeDebugProxyCaptureAsync(settings);
      const commands = committed.mock.calls.map(([command]) => command);
      expect(commands).toEqual([
        ...(outcome === "success"
          ? [
              expect.objectContaining({
                type: "capture.recordEventWithPayload",
                input: expect.objectContaining({
                  event: expect.objectContaining({ kind: "request", flowId: "cold-flow" }),
                  payload: expect.objectContaining({ data: Buffer.from("cold request") }),
                }),
              }),
              expect.objectContaining({
                type: "capture.recordEventWithPayload",
                input: expect.objectContaining({
                  event: expect.objectContaining({
                    kind: "response",
                    flowId: "cold-flow",
                    status: 204,
                  }),
                  payload: expect.objectContaining({ data: Buffer.alloc(0) }),
                }),
              }),
            ]
          : [
              expect.objectContaining({
                type: "capture.recordEvent",
                input: expect.objectContaining({
                  kind: "error",
                  flowId: "cold-flow",
                  errorText: transportFailure.message,
                }),
              }),
            ]),
        {
          type: "capture.endSession",
          input: { sessionId: settings.sessionId, endedAt: expect.any(Number) },
        },
      ]);
    } finally {
      ready.resolve();
      await operation;
      try {
        if (completed?.kind === "success") {
          await completed.value.release();
        }
      } finally {
        await finalizeDebugProxyCaptureAsync(settings);
      }
    }
  },
);
