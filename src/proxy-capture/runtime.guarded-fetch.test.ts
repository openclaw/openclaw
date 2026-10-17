import type { ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

let fixture: Awaited<ReturnType<typeof captureRoots>>;
let controller: AbortController;
beforeEach(async () => {
  controller = new AbortController();
  fixture = await captureRoots();
});
afterEach(async () => {
  controller.abort();
  await fixture.close();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function captureRoots() {
  const roots = [tempDirs.make("capture-guard-a-"), tempDirs.make("capture-guard-b-")];
  const originalFetch = globalThis.fetch;
  let transportedResponse: Response | undefined;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    transportedResponse = await originalFetch(...args);
    return transportedResponse;
  });
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
  const active = [...settings];
  return {
    settings,
    fetch: savedWrapper,
    response: () => transportedResponse,
    readEvents: () =>
      Promise.all(
        roots.map(async (root, index) => {
          const reader = createDebugProxyCaptureReaderAsync({
            env: { ...process.env, OPENCLAW_STATE_DIR: root },
          });
          return (await reader.getSessionEvents(settings[index]!.sessionId)).toReversed();
        }),
      ),
    async replace(root: number) {
      const replacementSettings = settings[root]!;
      active.push(replacementSettings);
      vi.stubEnv("OPENCLAW_STATE_DIR", roots[root]);
      await initializeDebugProxyCaptureAsync("replacement", replacementSettings);
      const replacement = await acquireDebugProxyCaptureStoreAsync();
      leases.push(replacement);
      return replacement;
    },
    async close() {
      for (const setting of active.splice(0)) {
        await finalizeDebugProxyCaptureAsync(setting);
        const lease = leases.shift();
        if (lease) {
          await lease.release();
          await closeOpenClawStateDatabaseByPathAsync(lease.store.dbPath);
        }
      }
    },
  };
}

type Route = "patched" | "guarded";
function requestResult(url: string, capture?: false, route: Route = "guarded") {
  const signal = controller.signal;
  const policy = { allowPrivateNetwork: true };
  const operation =
    route === "patched"
      ? fixture.fetch(url, { signal }).then((response) => ({ response, release: async () => {} }))
      : fetchWithSsrFGuard({ url, capture, signal, pinDns: false, policy });
  return operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

async function withPendingFetch(
  path: string,
  run: (response: ServerResponse, result: ReturnType<typeof requestResult>) => Promise<void>,
  capture?: false,
  route: Route = "guarded",
) {
  const arrived = createDeferredCore<ServerResponse>();
  await withServer(
    (request, response) => {
      request.resume();
      arrived.resolve(response);
    },
    async (baseUrl) => {
      const operation = requestResult(`${baseUrl}/${path}`, capture, route);
      await run(await arrived.promise, operation);
    },
  );
}

it("captures RequestInit overrides as sent by the global fetch transport", async () => {
  const headers = { "x-override": "new", "content-type": "application/json" };
  await withServer(
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          request.method,
          request.headers["x-original"],
          request.headers["x-override"],
          await text(request),
        ]),
      );
    },
    async (baseUrl) => {
      const originalHeaders = { "x-original": "old" };
      const request = new Request(`${baseUrl}/overrides`, {
        method: "PUT",
        headers: originalHeaders,
        body: "old",
      });
      const response = await fixture.fetch(request, { method: "POST", headers, body: "new" });
      expect(await response.json()).toEqual(["POST", null, "new", "new"]);
    },
  );
  await fixture.close();
  const [events] = await fixture.readEvents();
  expect(events?.[0]).toMatchObject({ kind: "request", method: "POST", dataText: "new" });
  expect(JSON.parse(String(events?.[0]?.headersJson))).toEqual(headers);
});

it("records an active transport rejection once through the global owner", async () => {
  const secret = "fixture-transport-secret";
  registerSecretValueForRedaction(secret);
  const reason = new Error(`caller abort ${secret}`);
  await withPendingFetch(
    "rejection",
    async (response, operation) => {
      controller.abort(reason);
      response.end();
      const completed = await operation;
      expect(completed.error).toBe(reason);
      expect(completed.value).toBeUndefined();
    },
    false,
  );
  await fixture.close();
  const events = await fixture.readEvents();
  expect(events.map((rows) => rows.length)).toEqual([1, 0]);
  const event = events[0]![0]!;
  expect(event).toMatchObject({ kind: "error", direction: "local", method: "GET" });
  expect(event).toMatchObject({
    path: "/rejection",
    errorText: "caller abort [REDACTED]",
    status: null,
  });
  expect(JSON.parse(String(event.metaJson))).toMatchObject({ captureOrigin: "global-fetch" });
});

// Patched fetch owns root 0; guarded fetch admits ambient root 1.
// Both routes get same-root and cross-root replacements.
it.each([
  ["patched", 0, "response"],
  ["patched", 0, "abort"],
  ["patched", 1, "response"],
  ["patched", 1, "abort"],
  ["guarded", 0, "response"],
  ["guarded", 0, "abort"],
  ["guarded", 1, "response"],
  ["guarded", 1, "abort"],
] as const)(
  "fences delayed %s responses from replacement root %i (%s)",
  async (route, root, outcome) => {
    const reason = new Error("fixture caller abort");
    await withPendingFetch(
      "delayed",
      async (response, operation) => {
        await fixture.close();
        const replacement = await fixture.replace(root);
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
          expect(completed.value!.response).toBe(fixture.response());
          expect(completed.value!.response.headers.get("x-fixture")).toBe("late-response");
          expect(await completed.value!.response.text()).toBe("late response");
          await completed.value!.release();
        }
        await finalizeDebugProxyCaptureAsync(fixture.settings[root]);
        expect(await replacement.store.getSessionEvents(fixture.settings[root]!.sessionId)).toEqual(
          [],
        );
        expect((await fixture.readEvents()).map((events) => events.length)).toEqual([0, 0]);
      },
      undefined,
      route,
    );
  },
);
