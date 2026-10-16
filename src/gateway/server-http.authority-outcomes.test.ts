import { once } from "node:events";
import { IncomingMessage, request, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as lifecycle from "../infra/http-request-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  bindHttpResponseAuthority,
  captureHttpRequestAuthority,
  runGatewayHttpRequest,
} from "./http-request-authority.js";
import { GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE } from "./operator-access-policy.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

const route = vi.fn<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>>();
const log = createSubsystemLogger("test/http-authority");
let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;
const connectionWork = new GatewayConnectionWork();
const context = createGatewayRequestContext(makeContextParams({ connectionWork }));
let requestEntryLifetime: GatewayRequestEntryLifetime;
let cancellations: string[];
let stopDiagnostics: (() => void) | undefined;
const clients = new Set<ReturnType<typeof request>>();
const releases: Array<() => void> = [];

function createRelease() {
  const release = createDeferred();
  releases.push(release.resolve);
  return release;
}

function watchCancellations() {
  cancellations = [];
  stopDiagnostics = onInternalDiagnosticEvent((event) => {
    if (event.type === "gateway.http.cancelled") {
      cancellations.push(event.source);
    }
  });
}

function createClientRequest(surface = "core", onResponse?: (res: IncomingMessage) => void) {
  const client = request(
    { host: "127.0.0.1", port: listener.claim.port, path: `/authority/${surface}`, agent: false },
    onResponse,
  );
  client.on("error", () => {});
  clients.add(client);
  return client;
}

async function drainRequests() {
  await connectionWork.runWhenIdle(() => {});
  await waitForDiagnosticEventsDrained();
}

beforeAll(async () => {
  const startup = new AsyncWorkScope();
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    pluginId: "authority-fixture",
    source: "fixture",
    path: "/authority/plugin",
    match: "exact",
    auth: "plugin",
    handler: route,
  });
  listener = await startup.track(() =>
    reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "",
          resolvedAuth: { mode: "none", allowTailscale: false },
          getRuntimeConfig: () => ({}),
          getGatewayRequestContext: () => context,
          httpRequestLifetime: context,
          handleHooksRequest: (req, res) =>
            req.url === "/authority/core" ? route(req, res) : Promise.resolve(false),
          handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
          shouldEnforcePluginGatewayAuth: () => false,
        }),
    }),
  );
  // Production listens inside startup, then retires that scope before serving requests.
  await startup.drain();
});

beforeEach(() => {
  requestEntryLifetime = new GatewayRequestEntryLifetime();
  context.requestEntryLifetime = requestEntryLifetime;
});

afterEach(async () => {
  clients.forEach((client) => client.destroy());
  releases.forEach((release) => release());
  const runHttpConnectionRequest = lifecycle.runHttpConnectionRequest;
  if (vi.isMockFunction(runHttpConnectionRequest)) {
    await Promise.all(runHttpConnectionRequest.mock.results.map((result) => result.value));
  }
  await connectionWork.runWhenIdle(() => {});
  clients.clear();
  releases.length = 0;
  stopDiagnostics?.();
  stopDiagnostics = undefined;
  route.mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await listener.releaseListener();
  } finally {
    await listener.claim.release();
    await connectionWork.drain();
  }
});

it.each([false, true])(
  "admits shutdown closure only for an ended request lifetime (ended=%s)",
  async (ended) => {
    const work = new GatewayConnectionWork();
    const entries = new GatewayRequestEntryLifetime();
    if (ended) {
      entries.beginClose();
    }
    await work.drain();
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    const handle = vi.fn(async (): Promise<undefined> => undefined);
    try {
      const result = runGatewayHttpRequest(
        req,
        res,
        { requestEntryLifetime: entries, trackExecution: (run) => work.track(run) },
        handle,
      );
      if (ended) {
        await expect(result).resolves.toBeUndefined();
        expect(res.destroyed).toBe(true);
      } else {
        await expect(result).rejects.toThrow("Async work scope is closed");
      }
      expect(handle).not.toHaveBeenCalled();
    } finally {
      res.destroy();
      req.destroy();
    }
  },
);

it.each([false, true])(
  "keeps delivered HTTP work out of cancellation telemetry (rejected=%s)",
  async (rejected) => {
    const errors = rejected ? undefined : vi.spyOn(console, "error").mockImplementation(() => {});
    watchCancellations();
    route.mockImplementation(async (req, res) => {
      if (rejected) {
        await lifecycle.sendHttpRequestRejection(req, res, 413, "Payload too large", "text/plain");
      } else {
        getAsyncWorkSignal()?.throwIfAborted();
        res.end("live request");
      }
      return true;
    });
    const response = await fetch(
      "http://127.0.0.1:" + listener.claim.port + "/authority/core",
      rejected ? undefined : { headers: { Connection: "close" } },
    );
    expect([response.status, await response.text()]).toEqual(
      rejected ? [413, "Payload too large"] : [200, "live request"],
    );
    await drainRequests();
    if (!rejected) {
      expect(errors).not.toHaveBeenCalled();
    }
    expect(cancellations).toEqual([]);
  },
);

it.each(["core", "plugin"])(
  "cancels disconnected %s reads without logging a handler failure",
  async (surface) => {
    const entered = createDeferred();
    const cancelled = createRelease();
    const finished = createDeferred();
    const releaseCleanup = createRelease();
    let cleanup = Promise.resolve();
    let cleanupBelongsToRequest = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(log, "warn").mockImplementation(() => {});
    watchCancellations();
    route.mockImplementation(async (_req, _res) => {
      const signal = getAsyncWorkSignal();
      expect(signal?.aborted).toBe(false);
      const abort = () => {
        cleanup = trackAsyncWork(async () => {
          cleanupBelongsToRequest = getAsyncWorkSignal() === signal;
          await releaseCleanup.promise;
        });
        void cleanup.catch(() => {});
        cancelled.resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
      entered.resolve();
      try {
        await cancelled.promise;
        signal?.throwIfAborted();
        throw new Error("Disconnected read was not cancelled");
      } finally {
        signal?.removeEventListener("abort", abort);
        finished.resolve();
      }
    });
    const requests = vi.spyOn(lifecycle, "runHttpConnectionRequest");
    const client = createClientRequest(surface);
    client.end();
    await entered.promise;
    client.destroy();
    await finished.promise;
    await Promise.all(requests.mock.results.map((result) => result.value));
    expect([cleanupBelongsToRequest, connectionWork.hasPendingWork]).toEqual([true, true]);
    releaseCleanup.resolve();
    await cleanup;
    await drainRequests();
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(cancellations).toEqual(["client"]);
  },
);

it.each([
  { ended: false, source: "shutdown" },
  { ended: true, source: "shutdown" },
  { ended: true, source: "client" },
] as const)(
  "joins an unfinished response after $source (ended=$ended)",
  async ({ ended, source }) => {
    const partial = createDeferred();
    const entered = createDeferred<ServerResponse>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    watchCancellations();
    route.mockImplementation(async (_req, res) => {
      if (ended) {
        // Exceed TCP buffering so end() cannot finish flushing into the paused reader.
        res.end(Buffer.alloc(16 * 1024 * 1024));
      } else {
        res.write("partial");
      }
      entered.resolve(res);
      return true;
    });
    const client = createClientRequest("core", (response) => {
      response.once("data", () => {
        response.pause();
        partial.resolve();
      });
      response.on("error", () => {});
    });
    client.end();
    const response = await entered.promise;
    await partial.promise;
    expect([response.writableEnded, response.writableFinished]).toEqual([ended, false]);
    const closed = once(response, "close");
    if (source === "shutdown") {
      requestEntryLifetime.beginClose();
      expect(response.destroyed).toBe(true);
    } else {
      // ClientRequest.destroy() drains paused response data; reset the transport instead.
      client.socket!.resetAndDestroy();
    }
    await closed;
    await drainRequests();
    expect(errors).not.toHaveBeenCalled();
    expect(cancellations).toEqual([source]);
  },
);

// Each request owner consumes both authority error types and preserves unexpected errors.
// Shared response handling covers disconnect, staged headers, and partial streams once.
it.each([
  ["core", "disconnect"],
  ["core", "client expired"],
  ["core", "operator revoked"],
  ["core", "unexpected"],
  ["core", "unexpected abort"],
  ["plugin", "stream client expired"],
  ["plugin", "stream operator revoked"],
  ["plugin", "unexpected"],
  ["plugin", "unexpected abort"],
])("Gateway HTTP %s owns %s after awaited request work", async (surface, outcome) => {
  const entered = createDeferred<ServerResponse>();
  const release = createRelease();
  const streaming = createDeferred();
  const operator = new AbortController();
  let auth: ResolvedGatewayAuth = { mode: "token", token: "before", allowTailscale: false };
  const unexpected = outcome.startsWith("unexpected");
  const streamingResponse = outcome.startsWith("stream");
  const disconnected = outcome === "disconnect";
  const closed = disconnected || streamingResponse;
  const [status, message, type] =
    outcome === "client expired"
      ? [401, "Unauthorized", "unauthorized"]
      : outcome === "operator revoked"
        ? [403, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE, "forbidden"]
        : [500, "Internal Server Error", ""];
  const unexpectedError =
    outcome === "unexpected abort"
      ? new DOMException("Unrelated upstream cancellation", "AbortError")
      : new Error("HTTP request authority expired");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warnings = vi.spyOn(log, "warn").mockImplementation(() => {});
  const requests = vi.spyOn(lifecycle, "runHttpConnectionRequest");
  route.mockImplementation(async (req, res) => {
    const authority = bindHttpResponseAuthority(
      {
        operatorAccessAuthority: {
          signal: operator.signal,
          assertCurrent: () => operator.signal.throwIfAborted(),
        },
      },
      res,
      captureHttpRequestAuthority({
        req,
        auth,
        cfg: {},
        getRuntimeConfig: () => ({}),
        getResolvedAuth: () => auth,
      }),
    );
    authority.assertCurrent();
    if (streamingResponse) {
      res.write("partial");
    } else if (!disconnected) {
      res.setHeader("Content-Length", "1");
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Disposition", "attachment; filename=report.txt");
      res.setHeader("ETag", '"prepared-report"');
      res.setHeader("Cache-Control", "public, max-age=31536000");
      res.setHeader("Access-Control-Allow-Origin", "https://example.test");
      res.statusMessage = "Download Ready";
    }
    entered.resolve(res);
    await release.promise;
    if (unexpected) {
      throw unexpectedError;
    }
    authority.assertCurrent();
    res.end("must not disclose prepared data");
    return true;
  });
  const response = createDeferred<{
    status?: number;
    statusMessage?: string;
    headers?: IncomingMessage["headers"];
    body: string;
    aborted?: boolean;
  }>();
  const client = createClientRequest(surface, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      body += chunk;
      streaming.resolve();
    });
    res.once("end", () =>
      response.resolve({
        status: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        body,
      }),
    );
    res.once("aborted", () => response.resolve({ status: res.statusCode, body, aborted: true }));
    res.once("error", (error) => {
      if (!streamingResponse) {
        response.reject(error);
      }
    });
  });
  client.once("error", (error) => {
    if (disconnected) {
      response.resolve({ body: "" });
    } else {
      response.reject(error);
    }
  });
  client.end();
  const res = await entered.promise;
  if (streamingResponse) {
    await streaming.promise;
  }
  if (disconnected) {
    const responseClosed = once(res, "close");
    client.destroy();
    await responseClosed;
  } else if (outcome.endsWith("client expired")) {
    auth = { ...auth, token: "after" };
  } else if (outcome.endsWith("operator revoked")) {
    operator.abort();
  }
  const end = vi.spyOn(res, "end");
  const write = vi.spyOn(res, "write");
  const headers = vi.spyOn(res, "setHeader");
  const writeHead = vi.spyOn(res, "writeHead");
  release.resolve();
  await requests.mock.results[0]!.value;
  const { headers: responseHeaders, statusMessage, ...received } = await response.promise;
  expect(write).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledTimes(closed ? 0 : 1);
  if (closed) {
    expect(headers).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
  }
  if (streamingResponse) {
    expect(received).toEqual({ status: 200, body: "partial", aborted: true });
  } else if (!closed) {
    expect(received).toEqual({
      status,
      body: unexpected ? message : JSON.stringify({ error: { message, type } }),
    });
    expect(statusMessage).toBe(type === "forbidden" ? "Forbidden" : message);
    expect(responseHeaders?.["content-type"]).toBe(
      unexpected ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    );
    const contentLength = responseHeaders?.["content-length"];
    if (contentLength !== undefined) {
      expect(contentLength).toBe(String(Buffer.byteLength(received.body)));
    }
    expect(responseHeaders?.["content-encoding"]).toBeUndefined();
    expect(responseHeaders?.["content-disposition"]).toBeUndefined();
    expect(responseHeaders?.etag).toBeUndefined();
    expect(responseHeaders?.["cache-control"]).toBe("no-store");
    expect(responseHeaders?.["access-control-allow-origin"]).toBe("https://example.test");
    expect(responseHeaders?.["x-content-type-options"]).toBe("nosniff");
  }
  if (unexpected) {
    if (surface === "core") {
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        "[gateway-http] unhandled error in request handler:",
        unexpectedError,
      );
    } else {
      expect(warnings).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("plugin http route failed"),
      );
    }
  } else {
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  }
});
