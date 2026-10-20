import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { resolveDebugProxySettings } from "./env.js";
import { finalizeDebugProxyCaptureAsync, initializeDebugProxyCaptureAsync } from "./runtime.js";
import { createDebugProxyCaptureReaderAsync } from "./store-readonly.async.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function captureRoots() {
  const roots = [tempDirs.make("capture-guard-a-"), tempDirs.make("capture-guard-b-")];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", originalFetch);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", roots[0]);
  const first = resolveDebugProxySettings();
  await initializeDebugProxyCaptureAsync("first", first);
  const firstLease = await acquireDebugProxyCaptureStoreAsync();
  const savedWrapper = globalThis.fetch;
  vi.stubEnv("OPENCLAW_STATE_DIR", roots[1]);
  const second = resolveDebugProxySettings();
  const secondLease = await acquireDebugProxyCaptureStoreAsync();
  expect(second.sessionId).toBe(first.sessionId);
  const settings = [first, second];
  const leases = [firstLease, secondLease];
  let closing: Promise<void> | undefined;
  return {
    roots,
    settings,
    leases,
    savedWrapper,
    readEvents: () =>
      Promise.all(
        roots.map((root, index) =>
          createDebugProxyCaptureReaderAsync({
            env: { ...process.env, OPENCLAW_STATE_DIR: root },
          })
            .getSessionEvents(settings[index]!.sessionId)
            .then((events) => events.toReversed()),
        ),
      ),
    close() {
      closing ??= (async () => {
        for (const [index, lease] of leases.entries()) {
          await finalizeDebugProxyCaptureAsync(settings[index]);
          await lease.release();
          await closeOpenClawStateDatabaseByPathAsync(lease.store.dbPath);
        }
      })();
      return closing;
    },
  };
}

describe("guarded capture ownership", () => {
  it("captures RequestInit overrides as sent by the global fetch transport", async () => {
    const fixture = await captureRoots();
    try {
      await withServer(
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                method: request.method,
                originalHeader: request.headers["x-original"],
                overrideHeader: request.headers["x-override"],
                body: Buffer.concat(chunks).toString(),
              }),
            );
          });
        },
        async (baseUrl) => {
          const request = new Request(`${baseUrl}/overrides`, {
            method: "PUT",
            headers: { "x-original": "original" },
            body: "original body",
          });
          const response = await fixture.savedWrapper(request, {
            method: "POST",
            headers: { "x-override": "override", "content-type": "application/json" },
            body: "override body",
          });
          expect(await response.json()).toEqual({
            method: "POST",
            overrideHeader: "override",
            body: "override body",
          });
        },
      );
      await fixture.close();
      const [events] = await fixture.readEvents();
      expect(events?.[0]).toMatchObject({
        kind: "request",
        method: "POST",
        dataText: "override body",
      });
      expect(JSON.parse(String(events?.[0]?.headersJson))).toEqual({
        "content-type": "application/json",
        "x-override": "override",
      });
    } finally {
      await fixture.close();
    }
  });

  it("records an active transport rejection once through the global owner", async () => {
    const fixture = await captureRoots();
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
            capture: false,
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
      await fixture.close();
      const events = await fixture.readEvents();
      expect(events.map((rows) => rows.length)).toEqual([1, 0]);
      const event = events[0]![0]!;
      expect(event).toMatchObject({
        kind: "error",
        direction: "local",
        method: "GET",
        path: "/rejection",
        errorText: "caller abort [REDACTED]",
      });
      expect(event.status).toBeNull();
      expect(JSON.parse(String(event.metaJson))).toMatchObject({
        captureOrigin: "global-fetch",
      });
    } finally {
      controller.abort();
      await fixture.close();
    }
  });

  it.each(["response", "abort"] as const)(
    "keeps a delayed caller %s while retired admissions stay fenced",
    async (outcome) => {
      const fixture = await captureRoots();
      const arrived = createDeferredCore<ServerResponse>();
      const controller = new AbortController();
      const reason = new Error("fixture caller abort");
      let replacement: Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>> | undefined;
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
            await fixture.close();
            await initializeDebugProxyCaptureAsync("replacement", fixture.settings[1]);
            replacement = await acquireDebugProxyCaptureStoreAsync();
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
            await finalizeDebugProxyCaptureAsync(fixture.settings[1]);
            expect(
              await replacement.store.getSessionEvents(fixture.settings[1]!.sessionId),
            ).toEqual([]);
            expect((await fixture.readEvents()).map((events) => events.length)).toEqual([0, 0]);
          },
        );
      } finally {
        controller.abort();
        await finalizeDebugProxyCaptureAsync(fixture.settings[1]);
        await replacement?.release();
        await fixture.close();
      }
    },
  );
});
