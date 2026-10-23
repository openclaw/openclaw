import { EventEmitter } from "node:events";
import { createServer, ServerResponse, type IncomingMessage } from "node:http";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../process/gateway-work-admission.test-helpers.js";
import {
  readJsonBodyOrError,
  retainGatewayHttpResponseWork,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
  sendRateLimited,
  setDefaultSecurityHeaders,
  setSseHeaders,
  watchClientDisconnect,
} from "./http-common.js";
import { makeMockHttpReqRes, makeMockHttpResponse } from "./test-http-response.js";

const readJsonBodyMock = vi.hoisted(() => vi.fn());

// mock-isolation: Drive body-read failures without loading hook config or dispatch state.
vi.mock("./hooks.js", () => ({ readJsonBody: readJsonBodyMock }));

beforeEach(() => {
  readJsonBodyMock.mockReset();
  resetDiagnosticEventsForTest();
});

function expectJsonResponse(
  res: ServerResponse,
  end: ReturnType<typeof makeMockHttpResponse>["end"],
  statusCode: number,
  body: unknown,
) {
  expect(res.statusCode).toBe(statusCode);
  expect(end).toHaveBeenCalledWith(JSON.stringify(body));
}

function mockDisconnect(
  socket = new EventEmitter(),
  resSocket: EventEmitter | null = socket,
  controller = new AbortController(),
) {
  const { req, res } = makeMockHttpReqRes(socket, resSocket);
  const onDisconnect = vi.fn();
  const cleanup = watchClientDisconnect(req, res, controller, onDisconnect);
  return { res, controller, onDisconnect, cleanup };
}

it("sets the complete default security policy", () => {
  const { res, setHeader } = makeMockHttpResponse();
  setDefaultSecurityHeaders(res);
  expect(Object.fromEntries(setHeader.mock.calls)).toEqual({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  });
});

it("sendMissingScopeForbidden preserves the legacy response without a concrete scope", () => {
  const { res, end } = makeMockHttpResponse();
  sendMissingScopeForbidden(res, undefined);
  expectJsonResponse(res, end, 403, {
    ok: false,
    error: { type: "forbidden", message: "missing scope: undefined" },
  });
});

it("sendMethodNotAllowed defaults the Allow header to POST and responds 405", () => {
  const { res, setHeader, end } = makeMockHttpResponse();
  sendMethodNotAllowed(res);
  expect(setHeader).toHaveBeenCalledWith("Allow", "POST");
  expect(res.statusCode).toBe(405);
  expect(end).toHaveBeenCalledWith("Method Not Allowed");
});

it("sendRateLimited responds with 429 and no Retry-After when retryAfterMs is omitted", () => {
  const { res, setHeader, end } = makeMockHttpResponse();
  sendRateLimited(res);
  expect(setHeader.mock.calls.map(([name]) => name)).not.toContain("Retry-After");
  expectJsonResponse(res, end, 429, {
    error: {
      message: "Too many failed authentication attempts. Please try again later.",
      type: "rate_limited",
    },
  });
});

describe("readJsonBodyOrError", () => {
  it.each([
    ["payload too large", 413, "Payload too large"],
    ["request body timeout", 408, "Request body timeout"],
  ] as const)("rejects %s with complete response", async (error, status, message) => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: false, error });
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const tasks: Promise<unknown>[] = [];
    const server = createServer((req, res) => {
      setDefaultSecurityHeaders(res);
      tasks.push(readJsonBodyOrError(req, res, 1024));
    });
    const origin = await listenLoopback(server);
    try {
      const response = await fetch(origin, {
        method: "POST",
        body: "x".repeat(2048),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("connection")).toBe("close");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual({
        error: { message, type: "invalid_request_error" },
      });
      if (status === 413) {
        expect(events.find((entry) => entry.type === "payload.large")).toMatchObject({
          surface: "gateway.http.json",
          action: "rejected",
          bytes: 2048,
          limitBytes: 1024,
          reason: "json_body_limit",
        });
      }
    } finally {
      stop();
      await closeHttpServer(server);
      await Promise.all(tasks);
    }
  });

  it("responds with 400 for other parse failures", async () => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: false, error: "bad json" });
    const { res, end } = makeMockHttpResponse();
    const destroy = vi.spyOn(res.req, "destroy");
    expect(await readJsonBodyOrError(res.req, res, 1024)).toBeUndefined();
    expectJsonResponse(res, end, 400, {
      error: { message: "bad json", type: "invalid_request_error" },
    });
    res.emit("finish");
    expect(destroy).not.toHaveBeenCalled();
  });
});

it.each([true, false])("setSseHeaders supports flushHeaders available: %s", (available) => {
  const { res, setHeader } = makeMockHttpResponse();
  const flushHeaders = vi.fn();
  if (available) {
    Object.assign(res, { flushHeaders });
  } else {
    expect(res).not.toHaveProperty("flushHeaders");
  }
  setSseHeaders(res);
  expect(res.statusCode).toBe(200);
  expect(Object.fromEntries(setHeader.mock.calls)).toMatchObject({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  expect(flushHeaders).toHaveBeenCalledTimes(available ? 1 : 0);
});

it.each(["destroyed", "buffered"])("retains only unfinished response work: %s", async (state) => {
  const before = getActiveGatewayRootWorkCount();
  const res = new ServerResponse({ method: "POST" } as IncomingMessage);
  let release: (() => void) | undefined;
  try {
    await runWithGatewayRootWorkAdmissionForTest(async () => {
      if (state === "destroyed") {
        res.destroy();
        expect(res.destroyed).toBe(true);
      } else {
        res.end("final reply");
        expect(res).toMatchObject({ writableEnded: true, writableFinished: false });
      }
      release = retainGatewayHttpResponseWork(res);
    });
    expect(getActiveGatewayRootWorkCount()).toBe(before + (state === "buffered" ? 1 : 0));
    res.emit("finish");
    expect(getActiveGatewayRootWorkCount()).toBe(before);
  } finally {
    release?.();
    res.destroy();
  }
});

describe("watchClientDisconnect", () => {
  it.each(["destroyed socket", "response close"])("aborts for %s", (cause) => {
    const socket = Object.assign(new EventEmitter(), { destroyed: cause === "destroyed socket" });
    const { res, controller, onDisconnect, cleanup } = mockDisconnect(socket);
    if (cause === "response close") {
      res.emit("close");
    }
    expect(controller.signal.aborted).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(cause === "destroyed socket" ? 1 : 0);
    cleanup();
    res.emit("close");
    expect(res.listenerCount("error")).toBe(0);
  });

  it.each(["late write", "already destroyed"])("handles response errors: %s", async (cause) => {
    const socket = new EventEmitter();
    const req = { socket } as IncomingMessage;
    const res = new ServerResponse({ method: "POST" } as IncomingMessage);
    const controller = new AbortController();
    const destroyed = cause === "already destroyed";
    const onDisconnect = destroyed ? undefined : vi.fn();
    const deferredError = destroyed
      ? new Promise<void>((resolve) => {
          process.nextTick(() => {
            res.emit("error", new Error("destroyed response failed during cleanup"));
            resolve();
          });
        })
      : undefined;
    if (destroyed) {
      res.destroy();
    }
    const cleanup = watchClientDisconnect(req, res, controller, onDisconnect);
    if (destroyed) {
      expect(controller.signal.aborted).toBe(true);
      expect(res.listenerCount("error")).toBe(1);
      await deferredError;
    } else {
      expect(res.listenerCount("error")).toBeGreaterThan(0);
      cleanup();
      res.end();
      res.write("late SSE frame");
      await nextImmediate();
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    }
    expect(controller.signal.aborted).toBe(true);
    cleanup();
    res.emit("close");
    expect(res.listenerCount("error")).toBe(0);
  });

  it("does not double-abort when the controller is already aborted", () => {
    const socket = new EventEmitter();
    const controller = new AbortController();
    controller.abort();
    const abortSpy = vi.spyOn(controller, "abort");
    const { onDisconnect } = mockDisconnect(socket, null, controller);
    socket.emit("close");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("releases both socket watchers after one disconnect and notifies once", () => {
    const reqSocket = new EventEmitter();
    const resSocket = new EventEmitter();
    const { controller, onDisconnect } = mockDisconnect(reqSocket, resSocket);
    expect(reqSocket.listenerCount("close")).toBe(1);
    expect(resSocket.listenerCount("close")).toBe(1);
    reqSocket.emit("close");
    expect(controller.signal.aborted).toBe(true);
    expect(reqSocket.listenerCount("close")).toBe(0);
    expect(resSocket.listenerCount("close")).toBe(0);
    resSocket.emit("close");
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it.each(["cleanup", "response completion"])("does not abort after %s", (phase) => {
    const socket = new EventEmitter();
    const { res, controller, cleanup } = mockDisconnect(socket, null);
    expect(socket.listenerCount("close")).toBe(1);
    if (phase === "cleanup") {
      cleanup();
    } else {
      res.emit("finish");
    }
    expect(socket.listenerCount("close")).toBe(0);
    socket.emit("close");
    expect(controller.signal.aborted).toBe(false);
    res.emit("close");
  });
});
