import { EventEmitter } from "node:events";
import { request as requestHttp } from "node:http";
import { setImmediate as settle } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  getSessionMcpRequestSignal,
  runWithSessionMcpRequestSignal,
} from "../agents/agent-bundle-mcp-request-context.js";
import {
  executeMcpAppOperation,
  issueTicket,
  mocks,
  nowMs,
  request,
  resetStandaloneMcpAppTestState,
  resolveMcpAppActiveView,
  runtime,
  startStandaloneHttp,
  view,
} from "./mcp-app-standalone.http.test-support.js";

const wait = <T>(promise: Promise<T>, message: string) => withTestTimeout(promise, 2_000, message);

describe("MCP App standalone request cancellation", () => {
  beforeEach(resetStandaloneMcpAppTestState);

  it.each([false, true])("owns the HTTP request lifetime (disconnect=%s)", async (disconnect) => {
    const started = createDeferred();
    const finish = createDeferred();
    let signal: AbortSignal | undefined;
    runtime.callTool.mockImplementationOnce(async () => {
      signal = getSessionMcpRequestSignal();
      started.resolve();
      await finish.promise;
      return { content: [{ type: "text", text: "completed once" }] };
    });
    const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs }).ticket;
    const server = await startStandaloneHttp();
    const controller = new AbortController();
    const response = fetch(server.url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `MCP-App ${ticket}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "tools/call", params: { name: "app-only" } }),
    }).then(
      async (value) => ({ body: await value.json() }),
      (error: unknown) => ({ error }),
    );
    try {
      await wait(started.promise, "standalone HTTP tool did not start");
      expect(signal?.aborted ?? false).toBe(false);
      expect(view.activeRequests).toBe(1);
      if (disconnect) {
        controller.abort();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        expect(view.activeRequests).toBe(1);
      }
      finish.resolve();
      const result = await response;
      if (!disconnect) {
        expect(result).toMatchObject({
          body: { ok: true, result: { content: [{ text: "completed once" }] } },
        });
      }
      await wait(server.handled, "standalone HTTP handler did not finish");
      expect(server.state.error).toBeUndefined();
      expect(view.activeRequests).toBe(0);
      expect(runtime.callTool).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      controller.abort();
      await Promise.all([
        response,
        wait(server.handled, "standalone HTTP cleanup did not finish"),
        server.close(),
      ]);
    }
  });

  it.each([false, true])(
    "settles a partial HTTP upload without leaking listeners (disconnect=%s)",
    async (disconnect) => {
      const clientDone = createDeferred<number | string>();
      const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs }).ticket;
      const server = await startStandaloneHttp();
      const client = requestHttp(
        server.url,
        {
          method: "POST",
          headers: { Authorization: `MCP-App ${ticket}`, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => clientDone.resolve(res.statusCode ?? 0));
        },
      );
      client.on("error", (error) => clientDone.resolve(error.message));
      try {
        client.write('{"method":"tools/call","params":');
        await wait(server.entered, "HTTP upload did not reach handler");
        if (disconnect) {
          client.destroy(new Error("fixture upload cancelled"));
        } else {
          client.end('{"name":"app-only"}}');
        }
        const outcome = await wait(clientDone.promise, "HTTP upload did not settle");
        await wait(server.handled, "HTTP upload handler did not settle");
        expect(outcome).toBe(disconnect ? "fixture upload cancelled" : 200);
        expect(server.state).toEqual({ error: undefined, leakedCloseListeners: 0 });
        expect(runtime.callTool).toHaveBeenCalledTimes(disconnect ? 0 : 1);
        expect(view.activeRequests).toBe(0);
      } finally {
        client.destroy();
        await Promise.all([
          wait(server.handled, "HTTP upload cleanup did not finish"),
          server.close(),
        ]);
      }
    },
  );

  it.each(["tools/call", "tools/list"] as const)(
    "cancels the %s catalog waiter without cancelling shared catalog work",
    async (method) => {
      const catalog = await runtime.getCatalog();
      const release = createDeferred<typeof catalog>();
      const getCatalog = runtime.getCatalog.getMockImplementation()!;
      runtime.getCatalog.mockImplementation(() => release.promise);
      const controller = new AbortController();
      const operation =
        method === "tools/call" ? { method, params: { name: "app-only" } } : { method };
      const active = await resolveMcpAppActiveView({
        sessionKey: "agent:main:main",
        viewId: view.viewId,
      });
      const otherSettled = vi.fn();
      const first = runWithSessionMcpRequestSignal(controller.signal, () =>
        executeMcpAppOperation(active, operation),
      );
      const cancelled = first.then(
        () => false,
        () => true,
      );
      const second = executeMcpAppOperation(active, operation).finally(otherSettled);
      try {
        await vi.waitFor(() => expect(view.activeRequests).toBe(2));
        if (method === "tools/list") {
          await vi.waitFor(() => expect(runtime.listTools).toHaveBeenCalledTimes(2));
        }
        controller.abort(new Error("App caller cancelled"));
        await expect(cancelled).resolves.toBe(true);
        expect(otherSettled).not.toHaveBeenCalled();
        expect(view.activeRequests).toBe(1);
        release.resolve(catalog);
        await expect(second).resolves.toBeDefined();
        expect(view.activeRequests).toBe(0);
        if (method === "tools/call") {
          expect(runtime.callTool).toHaveBeenCalledTimes(1);
        }
      } finally {
        release.resolve(catalog);
        await Promise.allSettled([first, second]);
        runtime.getCatalog.mockImplementation(getCatalog);
      }
    },
  );

  it("observes tools/list rejection when HTTP disconnects during async authorization", async () => {
    const entered = createDeferred();
    const authorize = createDeferred<boolean>();
    const socket = new EventEmitter();
    let signal: AbortSignal | undefined;
    const authorizeAppInteraction = async () => {
      signal = getSessionMcpRequestSignal();
      entered.resolve();
      return await authorize.promise;
    };
    let listCalls = 0;
    const requestRuntime = {
      ...runtime,
      // vi.fn observes returned promises for settledResults, masking orphaned rejections.
      async listTools() {
        listCalls += 1;
        getSessionMcpRequestSignal()?.throwIfAborted();
        return { tools: [] };
      },
    };
    const requestView = { ...view, runtime: requestRuntime, authorizeAppInteraction };
    mocks.peekSessionMcpRuntime.mockReturnValue(requestRuntime);
    mocks.getMcpAppViewLease.mockReturnValue(requestView);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      if (reason === signal?.reason) {
        unhandled.push(reason);
      }
    };
    process.on("unhandledRejection", onUnhandled);
    const ticket = issueTicket({ sessionKey: "agent:main:main", view: requestView, nowMs }).ticket;
    const pending = request({
      url: "/__openclaw__/mcp-app/view",
      method: "POST",
      authorization: `MCP-App ${ticket}`,
      body: { method: "tools/list", params: {} },
      socket,
    });
    try {
      await entered.promise;
      expect(signal?.aborted).toBe(false);
      socket.emit("close");
      expect(signal).toMatchObject({ aborted: true, reason: { name: "ClientDisconnectError" } });
      authorize.resolve(true);
      await pending;
      // Let Node report orphaned rejections; keep Vitest's own listener installed.
      await settle();
      expect(unhandled).toEqual([]);
      expect(listCalls).toBe(1);
      expect(runtime.getCatalog).not.toHaveBeenCalled();
      expect(requestView.activeRequests).toBe(0);
    } finally {
      authorize.resolve(true);
      await pending.finally(() => process.off("unhandledRejection", onUnhandled));
    }
  });
});
