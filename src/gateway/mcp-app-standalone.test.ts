import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as settle } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createMcpAppStandaloneTicket,
  createSerializedHost,
  handleMcpAppStandaloneHttpRequest,
  issueTicket,
  mocks,
  nowMs,
  releaseRuntimeLease,
  request,
  resetStandaloneMcpAppTestState,
  runtime,
  view,
} from "./mcp-app-standalone.http.test-support.js";

type Host = Awaited<ReturnType<typeof createSerializedHost>>;
function call(host: Host, id: string | number) {
  host.emit({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app-only" } });
}
function expectReply(host: Host, id: string | number, result: unknown) {
  expect(host.postMessage).toHaveBeenCalledWith(
    { jsonrpc: "2.0", id, result },
    "http://127.0.0.1:18790",
  );
}
function appRequest(ticket: string, params: Partial<Parameters<typeof request>[0]> = {}) {
  return request({
    url: "/__openclaw__/mcp-app/view",
    authorization: `MCP-App ${ticket}`,
    ...params,
  });
}
function operations(ticket: string) {
  return (body: unknown) => appRequest(ticket, { method: "POST", body });
}

describe("MCP App standalone host", () => {
  beforeEach(resetStandaloneMcpAppTestState);

  it("negotiates fullscreen and publishes display-mode changes through the serialized host", async () => {
    const host = await createSerializedHost();
    host.emit({
      jsonrpc: "2.0",
      id: "fullscreen",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    expect(host.frame.style.height).toBe("900px");
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/host-context-changed",
        params: { displayMode: "fullscreen" },
      }),
      "http://127.0.0.1:18790",
    );
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: "fullscreen", result: { mode: "fullscreen" } },
      "http://127.0.0.1:18790",
    );
    host.emit({
      jsonrpc: "2.0",
      id: "pip",
      method: "ui/request-display-mode",
      params: { mode: "pip" },
    });
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: "pip", result: { mode: "fullscreen" } },
      "http://127.0.0.1:18790",
    );
  });

  it("mints an opaque reusable ticket and rejects tampering and expiry at HTTP admission", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + 2 * 60_000);
    expect(issueTicket({ sessionKey: "agent:main:main", view, nowMs: nowMs + 1 })).toEqual(issued);
    const invoke = (ticket: string, now = nowMs) => appRequest(ticket, { now });
    expect((await invoke(issued.ticket)).res.statusCode).toBe(200);
    expect(mocks.peekSessionMcpRuntime).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
    const suffix = issued.ticket.endsWith("x") ? "y" : "x";
    expect((await invoke(`${issued.ticket.slice(0, -1)}${suffix}`)).res.statusCode).toBe(401);
    expect((await invoke(issued.ticket, issued.expiresAtMs + 1)).res.statusCode).toBe(401);
  });

  it("does not downgrade requester-bound views into bearer-only standalone authority", () => {
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:main:main",
        view: { ...view, requesterId: "alice" },
        toolOperationsAuthorized: true,
      }),
    ).toBeUndefined();
  });

  it("bounds ticket lifetime and omits issuance at capacity", () => {
    const shortView = { ...view, expiresAtMs: nowMs + 1_000 };
    expect(issueTicket({ sessionKey: "short", view: shortView, nowMs }).expiresAtMs).toBe(
      nowMs + 1_000,
    );
    vi.spyOn(Date, "now").mockReturnValue(nowMs + 1_001);
    for (let index = 0; index < 256; index += 1) {
      expect(
        createMcpAppStandaloneTicket({
          sessionKey: `agent:${index}`,
          view: { ...view, viewId: `mcp-app-${index}` },
          toolOperationsAuthorized: true,
        }),
      ).toBeDefined();
    }
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:overflow",
        view: { ...view, viewId: "mcp-app-overflow" },
        toolOperationsAuthorized: true,
      }),
    ).toBeUndefined();
  });

  it("binds tool authority and never reuses a stronger ticket for a read-only issuer", async () => {
    const stronger = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const readOnly = issueTicket({
      sessionKey: "agent:main:main",
      view,
      toolOperationsAuthorized: false,
      nowMs: nowMs + 1,
    });

    expect(readOnly.ticket).not.toBe(stronger.ticket);
    const payload = await appRequest(readOnly.ticket);
    expect(JSON.parse(String(payload.end.mock.calls[0]?.[0]))).toMatchObject({
      serverTools: false,
    });

    const denied = await appRequest(readOnly.ticket, {
      method: "POST",
      body: { method: "tools/call", params: { name: "app-only", arguments: {} } },
    });
    expect(denied.res.statusCode).toBe(403);
    expect(runtime.callTool).not.toHaveBeenCalled();

    const allowed = await appRequest(stronger.ticket, {
      method: "POST",
      body: { method: "tools/call", params: { name: "app-only", arguments: {} } },
    });
    expect(allowed.res.statusCode).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "public shell", path: "/__openclaw__/mcp-app", expectedStatus: 200 },
    {
      label: "authenticated multibyte view",
      path: "/__openclaw__/mcp-app/view",
      expectedStatus: 200,
      authorized: true,
    },
  ])(
    "keeps GET and HEAD metadata aligned over HTTP for $label",
    async ({ path, expectedStatus, authorized }) => {
      const originalHtml = view.html;
      view.html = "<!doctype html><p>caf\u00e9 \ud83e\udd9e</p>";
      const ticket = authorized
        ? issueTicket({ sessionKey: "agent:main:main", view, nowMs }).ticket
        : undefined;
      const server = createServer((req, res) => {
        void handleMcpAppStandaloneHttpRequest(req, res, {
          sandboxPort: 18_790,
        }).catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const headers = ticket ? { Authorization: `MCP-App ${ticket}` } : undefined;
        const get = await fetch(`${origin}${path}`, { headers });
        const body = Buffer.from(await get.arrayBuffer());
        const head = await fetch(`${origin}${path}`, { method: "HEAD", headers });

        expect(get.status).toBe(expectedStatus);
        expect(head.status).toBe(expectedStatus);
        expect(get.headers.get("content-length")).toBe(String(body.byteLength));
        expect(head.headers.get("content-length")).toBe(String(body.byteLength));
        expect((await head.arrayBuffer()).byteLength).toBe(0);
        expect(head.headers.get("cache-control")).toBe("no-store");

        if (path.endsWith("/view")) {
          expect(head.headers.get("vary")).toBe("Authorization");
        }
        if (authorized) {
          expect(body.toString()).toContain("caf\u00e9 \ud83e\udd9e");
        } else {
          expect(body.toString()).not.toContain(view.html);
          expect(body.toString()).not.toContain("agent:main:main");
          expect(get.headers.get("content-security-policy")).toMatch(
            /script-src 'sha256-[^']+';.*connect-src 'self'/u,
          );
        }
      } finally {
        view.html = originalHtml;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("bounds initial serialized body fetch with a visible outcome", async () => {
    const shell = await request({ url: "/__openclaw__/mcp-app" });
    const html = String(shell.end.mock.calls[0]?.[0]);
    const source = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
    expect(source).toBeDefined();

    let renderedError = "";
    const timeoutError = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const initialSignal = AbortSignal.abort(timeoutError);
    const initialTimeout = vi.fn(() => initialSignal);
    const initialFetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.reject(timeoutError) }),
    );

    runInNewContext(source!, {
      AbortSignal: { timeout: initialTimeout },
      URL,
      addEventListener: vi.fn(),
      document: {
        createElement: () => ({ className: "", textContent: "" }),
        getElementById: () => ({
          replaceChildren: (child: { textContent?: string }) => {
            renderedError = child.textContent ?? "";
          },
        }),
      },
      fetch: initialFetch,
      innerWidth: 800,
      location: { hash: "#ticket", origin: "http://127.0.0.1:18789" },
      matchMedia: () => ({ matches: false }),
      navigator: { language: "en" },
      setTimeout,
    });
    await vi.waitFor(() =>
      expect(renderedError).toBe("MCP App view timed out; reload to try again"),
    );
    expect(initialTimeout).toHaveBeenCalledWith(30_000);
    expect(initialFetch).toHaveBeenCalledWith(
      "/__openclaw__/mcp-app/view",
      expect.objectContaining({ signal: initialSignal }),
    );
  });

  it("returns capabilities only for handlers installed on the live view", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const route = "/__openclaw__/mcp-app/view";
    expect((await request({ url: route })).res.statusCode).toBe(401);
    expect((await request({ url: `${route}?ticket=${issued.ticket}` })).res.statusCode).toBe(401);
    const accepted = await appRequest(issued.ticket);
    expect(accepted.res.statusCode).toBe(200);
    expect(JSON.parse(String(accepted.end.mock.calls[0]?.[0]))).toMatchObject({
      html: view.html,
      sandboxPort: 18_790,
      serverTools: true,
      serverResources: true,
    });
    expect((await appRequest(issued.ticket)).res.statusCode).toBe(200);
    for (const replacement of [null, { ...runtime, sessionId: "runtime-replaced" }]) {
      mocks.peekSessionMcpRuntime.mockReturnValue(replacement);
      expect((await appRequest(issued.ticket)).res.statusCode).toBe(401);
    }
    mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
    for (const replacement of [
      { ...view, viewId: "mcp-app-replaced" },
      { ...view, sessionId: "runtime-replaced" },
    ]) {
      mocks.getMcpAppViewLease.mockReturnValue(replacement);
      expect((await appRequest(issued.ticket)).res.statusCode).toBe(401);
    }
  });

  it("cancels only the active serialized request", async () => {
    const id = 0;
    const host = await createSerializedHost();
    call(host, id);
    const operation = host.operations[0]!;
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } };
    host.emit(cancel, { source: {} });
    host.emit(cancel, { origin: "https://untrusted.example" });
    host.emit({ ...cancel, params: { requestId: "unknown" } });
    host.emit({ ...cancel, id: "not-a-notification" });
    expect(operation.signal?.aborted).toBe(false);
    host.emit(cancel);
    expect(operation.signal?.aborted).toBe(true);
    operation.result.resolve("late response");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => message.id === id)).toEqual([]);
    expect(host.timeout).toHaveBeenCalledTimes(1);

    call(host, "next");
    host.emit(cancel);
    expect(host.operations[1]?.signal?.aborted).toBe(false);
    host.operations[1]!.result.resolve("next result");
    await vi.waitFor(() => expectReply(host, "next", "next result"));
  });

  it("keeps the original reply when an active ID collides with initialization", async () => {
    const host = await createSerializedHost();
    call(host, 0);
    host.emit({ jsonrpc: "2.0", id: 0, method: "ui/initialize", params: {} });
    host.emit({ ...host.initialize, id: 0 });
    expect(host.operations).toHaveLength(1);
    expect(host.postMessage).not.toHaveBeenCalled();
    host.operations[0]!.result.resolve("original result");
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
    expectReply(host, 0, "original result");
  });

  it("retires resource reads when the page closes", async () => {
    const method = "resources/read";
    const host = await createSerializedHost();
    host.emit({ jsonrpc: "2.0", id: 1, method, params: {} });
    host.pagehide();
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    host.pageshow(true);
    expect(host.reload).not.toHaveBeenCalled();
    host.emit({ jsonrpc: "2.0", id: 2, method, params: {} });
    expect(host.operations).toHaveLength(1);
    host.operations[0]!.result.resolve("late result");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it("requests one fresh document on a persisted live-host return without replaying work", async () => {
    const host = await createSerializedHost();
    call(host, "old");
    expect(host.operations).toHaveLength(1);
    host.pagehide(true);
    expect(host.operations[0]!.signal?.aborted).toBe(true);
    host.operations[0]!.result.resolve("late result");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    // Observe the real serialized owner's Location API, not simulated browser cache eligibility.
    host.pageshow(true);
    expect(host.reload).toHaveBeenCalledOnce();
    host.pageshow(true);
    expect(host.reload).toHaveBeenCalledOnce();
    call(host, "next");
    expect(host.operations).toHaveLength(1);
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it("keeps an active host callable after a persisted pageshow without reload", async () => {
    const host = await createSerializedHost();
    host.pageshow(true);
    expect(host.reload).not.toHaveBeenCalled();
    call(host, "live");
    expect(host.operations).toHaveLength(1);
    host.operations[0]!.result.resolve("live result");
    await vi.waitFor(() => expectReply(host, "live", "live result"));
  });

  it("does not resurrect a failed host after persisted history events", async () => {
    const host = await createSerializedHost({ operationStatus: 401 });
    call(host, "old");
    host.operations[0]!.result.resolve("rejected");
    await vi.waitFor(() => expect(host.frame.remove).toHaveBeenCalledOnce());
    host.pagehide(true);
    expect(host.operations[0]!.signal?.aborted).toBe(true);
    host.pageshow(true);
    expect(host.reload).not.toHaveBeenCalled();
    call(host, "next");
    expect(host.operations).toHaveLength(1);
    host.operations[0]!.result.resolve("late result");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it.each([
    { persisted: true, outcome: "resolve" },
    { persisted: true, outcome: "reject" },
    { persisted: false, outcome: "resolve" },
    { persisted: false, outcome: "reject" },
  ])(
    "does not publish a retired bootstrap $outcome after pagehide (persisted=$persisted)",
    async ({ persisted, outcome }) => {
      const initialBody = createDeferred<unknown>();
      const host = await createSerializedHost({ initialBody });
      try {
        expect(host.replaceChildren).not.toHaveBeenCalled();
        host.pagehide(persisted);
        if (outcome === "resolve") {
          initialBody.resolve(host.payload);
        } else {
          initialBody.reject(new Error("retired initial body failed"));
        }
        await settle();
        expect(host.replaceChildren).not.toHaveBeenCalled();
        host.pageshow(true);
        expect(host.reload).toHaveBeenCalledTimes(persisted ? 1 : 0);
        expect(host.operations).toHaveLength(0);
      } finally {
        initialBody.resolve(host.payload);
      }
    },
  );

  it("does not fail the live frame when a retired 401 response body aborts", async () => {
    const host = await createSerializedHost({ abortable401Body: true });
    const cancel = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "cancelled" },
    };
    call(host, "cancelled");
    try {
      const operation = host.operations[0]!;
      await vi.waitFor(() => expect(operation.response?.bodyUsed).toBe(true));
      host.emit(cancel);
      expect(operation.signal?.aborted).toBe(true);
      expect(operation.signal?.reason.name).toBe("AbortError");
      // Native Response consumption rejects from the stream's actual AbortError; drain promise jobs.
      await settle();
      expect(host.frame.remove).not.toHaveBeenCalled();
      expect(host.replaceChildren).toHaveBeenCalledTimes(1);
      expect(host.postMessage).not.toHaveBeenCalled();
    } finally {
      host.emit(cancel);
    }
  });

  it("accepts a teardown response in the opposite request-ID namespace", async () => {
    const host = await createSerializedHost();
    call(host, 1);
    host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 1, method: "ui/resource-teardown", params: {} },
      "http://127.0.0.1:18790",
    );
    host.emit({ jsonrpc: "2.0", id: 1, result: {} });
    expect(host.frame.remove).toHaveBeenCalledOnce();
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    host.operations[0]!.result.resolve("late result");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it("finishes an existing call and async teardown save before unmount", async () => {
    const host = await createSerializedHost();
    const existingReply = createDeferred();
    const savedReply = createDeferred();
    let cleanup: Promise<void> | undefined;
    host.postMessage.mockImplementation((message) => {
      if (message.method === "ui/resource-teardown") {
        cleanup = Promise.resolve().then(async () => {
          await existingReply.promise;
          call(host, "save");
          await savedReply.promise;
          host.emit({ jsonrpc: "2.0", id: message.id, result: {} });
        });
      } else if (message.id === "existing" && "result" in message) {
        existingReply.resolve();
      } else if (message.id === "save" && "result" in message) {
        savedReply.resolve();
      }
    });
    try {
      call(host, "existing");
      host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
      expect(cleanup).toBeDefined();
      expect(host.frame.remove).not.toHaveBeenCalled();
      expect(host.operations[0]!.signal?.aborted).toBe(false);
      host.operations[0]!.result.resolve("existing saved");
      await vi.waitFor(() => expect(host.operations).toHaveLength(2));
      const save = host.operations.at(-1)!;
      expect(save.signal?.aborted).toBe(false);
      expect(host.frame.remove).not.toHaveBeenCalled();
      save.result.resolve("cleanup saved");
      await cleanup;
      expectReply(host, "save", "cleanup saved");
      expect(host.frame.remove).toHaveBeenCalledOnce();
      host.timers[0]!.run();
      expect(host.frame.remove).toHaveBeenCalledOnce();
    } finally {
      existingReply.resolve();
      savedReply.resolve();
      await cleanup;
      for (const operation of host.operations) {
        operation.result.resolve("cleanup");
      }
    }
  });

  it.each(["deadline", "persisted-pagehide"])(
    "retires graceful cleanup at %s without replay or late replies",
    async (terminal) => {
      const host = await createSerializedHost();
      const teardown = { jsonrpc: "2.0", method: "ui/notifications/request-teardown" };
      host.emit(teardown);
      call(host, "save");
      expect(host.operations).toHaveLength(1);
      expect(host.operations[0]!.signal?.aborted).toBe(false);
      host.emit(teardown);
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0]!.delayMs).toBe(1_000);
      if (terminal === "deadline") {
        host.timers[0]!.run();
        expect(host.frame.remove).toHaveBeenCalledOnce();
      } else {
        host.pagehide(terminal === "persisted-pagehide");
      }
      expect(host.operations[0]!.signal?.aborted).toBe(true);
      host.pageshow(true);
      expect(host.reload).not.toHaveBeenCalled();
      call(host, "late");
      host.operations[0]!.result.resolve("late save result");
      await settle();
      expect(host.operations).toHaveLength(1);
      expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    },
  );

  it("keeps simultaneous numeric and string request IDs independent", async () => {
    const host = await createSerializedHost();
    for (const id of [7, "7"]) {
      call(host, id);
    }
    expect(host.operations).toHaveLength(2);
    host.emit({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    expect(host.operations[1]?.signal?.aborted).toBe(false);
    host.operations[0]!.result.resolve("cancelled number");
    host.operations[1]!.result.resolve("live string");
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
    expectReply(host, "7", "live string");
  });

  it("does not let a retired completion affect a reused request ID", async () => {
    const host = await createSerializedHost();
    call(host, 0);
    host.emit({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } });
    // MCP forbids session ID reuse; old completion cleanup must still be harmless.
    call(host, 0);
    host.operations[0]!.result.resolve("retired result");
    await settle();
    expect(host.postMessage).not.toHaveBeenCalled();
    host.operations[1]!.result.resolve("current result");
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
    expectReply(host, 0, "current result");
  });

  it("executes only owning-server app-visible allowed tools and resources", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const invoke = operations(issued.ticket);

    const tool = await invoke({
      method: "tools/call",
      params: { name: "app-only", arguments: {} },
    });
    expect(tool.res.statusCode).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledWith("demo", "app-only", {});
    const resource = await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } });
    expect(resource.res.statusCode).toBe(200);
    expect(runtime.readResource).toHaveBeenCalledWith("demo", "ui://demo/state");

    for (const name of ["model-only", "not-allowed", "cross-only"]) {
      expect(
        (await invoke({ method: "tools/call", params: { name, arguments: {} } })).res.statusCode,
      ).toBe(403);
    }
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeLease).toHaveBeenCalled();
    expect(mocks.completeRetirement).toHaveBeenCalledWith(runtime);
  });

  it("inherits post-catalog grant revalidation from the shared operation boundary", async () => {
    const catalogStarted = createDeferred();
    const releaseCatalog = createDeferred<Awaited<ReturnType<typeof runtime.getCatalog>>>();
    runtime.getCatalog.mockImplementationOnce(async () => {
      catalogStarted.resolve();
      return await releaseCatalog.promise;
    });
    let grantActive = true;
    view.authorizeAppInteraction = vi.fn(async () => grantActive);
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });

    const pending = appRequest(issued.ticket, {
      method: "POST",
      body: { method: "tools/call", params: { name: "app-only", arguments: {} } },
    });
    await catalogStarted.promise;
    expect(view.authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    releaseCatalog.resolve({
      tools: [{ serverName: "demo", toolName: "app-only", uiVisibility: ["app"] }],
    });

    const denied = await pending;
    expect(denied.res.statusCode).toBe(403);
    expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(2);
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("denies resource reads from reconstructed read-only views", async () => {
    Object.assign(view, { readOnly: true });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const payload = await appRequest(issued.ticket);
    expect(JSON.parse(String(payload.end.mock.calls[0]?.[0]))).toMatchObject({
      serverResources: false,
    });
    const invoke = operations(issued.ticket);
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(403);
    expect(runtime.readResource).not.toHaveBeenCalled();
  });

  it("does not accept standalone server operations without explicit run authority", async () => {
    Object.assign(view, { allowedAppToolNames: undefined });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const invoke = operations(issued.ticket);

    expect((await invoke({ method: "tools/list", params: {} })).res.statusCode).toBe(403);
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(403);
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("revalidates expiry and enforces request concurrency through the ticket boundary", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    const invoke = (now: number) =>
      appRequest(issued.ticket, {
        method: "POST",
        now,
        body: { method: "resources/list", params: {} },
      });
    view.activeRequests = 4;
    expect((await appRequest(issued.ticket, { now: nowMs })).res.statusCode).toBe(429);
    expect((await invoke(nowMs)).res.statusCode).toBe(403);
    view.activeRequests = 0;
    expect((await invoke(issued.expiresAtMs + 1)).res.statusCode).toBe(401);

    let currentTime = nowMs;
    const clock = () => currentTime;
    expect(
      (
        await appRequest(issued.ticket, {
          method: "POST",
          clock,
          beforeBody: () => {
            currentTime = issued.expiresAtMs + 1;
          },
          body: { method: "resources/list", params: {} },
        })
      ).res.statusCode,
    ).toBe(401);
    expect(runtime.listResources).not.toHaveBeenCalled();
  });

  it("is path-scoped and rejects malformed operations", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs });
    expect((await request({ url: "/__openclaw__/mcp-app", method: "POST" })).res.statusCode).toBe(
      404,
    );
    expect((await request({ url: "/__openclaw__/mcp-app/other" })).handled).toBe(false);
    expect(
      (
        await appRequest(issued.ticket, {
          method: "POST",
          body: { method: "gateway.call", params: {} },
        })
      ).res.statusCode,
    ).toBe(400);
  });
});
