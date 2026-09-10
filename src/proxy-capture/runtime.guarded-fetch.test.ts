import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveDebugProxySettings } from "./env.js";
import { finalizeDebugProxyCapture, initializeDebugProxyCapture } from "./runtime.js";
import { acquireDebugProxyCaptureStore, closeDebugProxyCaptureStore } from "./store.sqlite.js";

afterEach(() => {
  closeDebugProxyCaptureStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function captureRoots() {
  const roots = [tempDirs.make("capture-guard-a-"), tempDirs.make("capture-guard-b-")];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", originalFetch);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", roots[0]);
  const first = resolveDebugProxySettings();
  initializeDebugProxyCapture("first", first);
  const firstLease = acquireDebugProxyCaptureStore();
  const savedWrapper = globalThis.fetch;
  vi.stubEnv("OPENCLAW_STATE_DIR", roots[1]);
  const second = resolveDebugProxySettings();
  const secondLease = acquireDebugProxyCaptureStore();
  expect(second.sessionId).toBe(first.sessionId);
  const settings = [first, second];
  const leases = [firstLease, secondLease];
  const recordings = leases.map(({ store }) => vi.spyOn(store, "recordEvent"));
  return {
    roots,
    settings,
    leases,
    recordings,
    originalFetch,
    savedWrapper,
    close() {
      for (const [index, lease] of leases.entries()) {
        finalizeDebugProxyCapture(settings[index]);
        lease.release();
        closeOpenClawStateDatabaseByPath(lease.store.dbPath);
      }
    },
  };
}

describe("guarded capture ownership", () => {
  it.each([
    "same-owner",
    "other-owner",
    "saved-wrapper",
    "caller-wrapper",
    "capture-disabled",
  ] as const)("uses one capture owner through %s", async (mode) => {
    const fixture = captureRoots();
    if (mode === "same-owner") {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixture.roots[0]);
    } else if (mode === "saved-wrapper") {
      initializeDebugProxyCapture("second", fixture.settings[1]);
    }
    const callerFetch = vi.fn<typeof fetch>((input, init) => fixture.originalFetch(input, init));
    try {
      await withServer(
        (request, response) => {
          request.resume();
          response.writeHead(200, { "x-fixture": "caller-response" });
          response.end("loopback response");
        },
        async (baseUrl) => {
          const result = await fetchWithSsrFGuard({
            url: `${baseUrl}/ownership`,
            pinDns: false,
            policy: { allowPrivateNetwork: true },
            ...(mode === "saved-wrapper"
              ? { fetchImpl: fixture.savedWrapper }
              : mode === "caller-wrapper"
                ? { fetchImpl: callerFetch }
                : {}),
            ...(mode === "capture-disabled" ? { capture: false } : {}),
            init: { method: "POST", body: "loopback request" },
          });
          try {
            expect(result.response.status).toBe(200);
            expect(result.response.headers.get("x-fixture")).toBe("caller-response");
            expect(await result.response.text()).toBe("loopback response");
          } finally {
            await result.release();
          }
        },
      );
      // Finalization settles any diagnostic clone before checking all writes.
      fixture.close();
      const events = fixture.recordings.map((recording) =>
        recording.mock.calls.map(([event]) => event),
      );
      // Disabling the guard recorder leaves an installed global recorder in control.
      const expected = mode === "capture-disabled" || mode === "same-owner" ? [2, 0] : [0, 2];
      expect(events.map((rows) => rows.length)).toEqual(expected);
      for (const rows of events.filter((captured) => captured.length > 0)) {
        expect(rows[0]).toMatchObject({ kind: "request", dataText: "loopback request" });
        expect(rows[1]).toMatchObject({ status: 200, flowId: rows[0]!.flowId });
        expect(["response", "error"]).toContain(rows[1]!.kind);
      }
      expect(callerFetch).toHaveBeenCalledTimes(mode === "caller-wrapper" ? 1 : 0);
    } finally {
      fixture.close();
    }
  });

  it.each(["guarded", "global"] as const)(
    "records an active transport rejection once through the %s owner",
    async (mode) => {
      const fixture = captureRoots();
      const arrived = createDeferredCore<ServerResponse>();
      const controller = new AbortController();
      const secret = "fixture-transport-secret";
      registerSecretValueForRedaction(secret);
      const reason = new Error(`caller abort ${secret}`);
      try {
        await withServer(
          (request, response) => {
            request.resume();
            arrived.resolve(response);
          },
          async (baseUrl) => {
            const operation = fetchWithSsrFGuard({
              url: `${baseUrl}/rejection`,
              pinDns: false,
              policy: { allowPrivateNetwork: true },
              signal: controller.signal,
              capture: mode === "global" ? false : { flowId: "guarded-rejection-flow" },
            }).then(
              (value) => ({ value, error: undefined }),
              (error: unknown) => ({ value: undefined, error }),
            );
            const response = await arrived.promise;
            controller.abort(reason);
            response.end();
            const completed = await operation;
            expect(completed.error).toBe(reason);
            expect(completed.value).toBeUndefined();
          },
        );
        fixture.close();
        const events = fixture.recordings.map((recording) =>
          recording.mock.calls.map(([event]) => event),
        );
        expect(events.map((rows) => rows.length)).toEqual(mode === "global" ? [1, 0] : [0, 1]);
        const event = events[mode === "global" ? 0 : 1]![0]!;
        expect(event).toMatchObject({
          kind: "error",
          direction: "local",
          method: "GET",
          path: "/rejection",
          errorText: "caller abort [REDACTED]",
          ...(mode === "guarded" ? { flowId: "guarded-rejection-flow" } : {}),
        });
        expect(event.status).toBeUndefined();
        expect(JSON.parse(event.metaJson!)).toMatchObject({
          captureOrigin: mode === "global" ? "global-fetch" : "guarded-fetch",
        });
      } finally {
        controller.abort();
        fixture.close();
      }
    },
  );

  it.each(["response", "abort"] as const)(
    "keeps a delayed caller %s while retired admissions stay fenced",
    async (outcome) => {
      const fixture = captureRoots();
      const arrived = createDeferredCore<ServerResponse>();
      const controller = new AbortController();
      const reason = new Error("fixture caller abort");
      let replacement: ReturnType<typeof acquireDebugProxyCaptureStore> | undefined;
      try {
        await withServer(
          (request, response) => {
            request.resume();
            arrived.resolve(response);
          },
          async (baseUrl) => {
            const operation = fetchWithSsrFGuard({
              url: `${baseUrl}/delayed`,
              pinDns: false,
              policy: { allowPrivateNetwork: true },
              signal: controller.signal,
            }).then(
              (value) => ({ value, error: undefined }),
              (error: unknown) => ({ value: undefined, error }),
            );
            const response = await arrived.promise;
            fixture.close();
            initializeDebugProxyCapture("replacement", fixture.settings[1]);
            replacement = acquireDebugProxyCaptureStore();
            const recordReplacement = vi.spyOn(replacement.store, "recordEvent");
            if (outcome === "abort") {
              controller.abort(reason);
            }
            response.writeHead(200, { "x-fixture": "late-response" });
            response.end("late response");
            const completed = await operation;
            if (outcome === "abort") {
              expect(completed.error).toBe(reason);
              expect(completed.value).toBeUndefined();
            } else {
              expect(completed.error).toBeUndefined();
              expect(completed.value!.response.headers.get("x-fixture")).toBe("late-response");
              expect(await completed.value!.response.text()).toBe("late response");
              await completed.value!.release();
            }
            finalizeDebugProxyCapture(fixture.settings[1]);
            expect(recordReplacement).not.toHaveBeenCalled();
            expect(fixture.recordings.map((recording) => recording.mock.calls.length)).toEqual([
              0, 0,
            ]);
          },
        );
      } finally {
        controller.abort();
        finalizeDebugProxyCapture(fixture.settings[1]);
        replacement?.release();
        fixture.close();
      }
    },
  );
});
