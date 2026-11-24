import { setImmediate as settle } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runStandaloneMcpAppHost } from "./mcp-app-standalone-host.js";
import {
  createMcpAppStandaloneTicket,
  createSerializedHost,
  issueTicket,
  mocks,
  nowMs,
  releaseRuntimeLease,
  request,
  resetStandaloneMcpAppTestState,
  runtime,
  startStandaloneHttp,
  view,
} from "./mcp-app-standalone.http.test-support.js";
import {
  getTailscalePublishedOrigin,
  prepareTailscalePublishedOrigin,
} from "./tailscale-published-origin.js";

const { materializeMcpAppChannelPresentation } = await import("./mcp-app-channel-action.js");

type Host = Awaited<ReturnType<typeof createSerializedHost>>;
function call(host: Host, id: string | number) {
  host.emit({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app-only" } });
}
function expectReply(host: Host, id: string | number, result: unknown) {
  expectMessage(host, { jsonrpc: "2.0", id, result });
}
function expectMessage(host: Host, message: unknown) {
  expect(host.postMessage).toHaveBeenCalledWith(message, "http://127.0.0.1:18790");
}
function appRequest(ticket: string, params: Partial<Parameters<typeof request>[0]> = {}) {
  return request({
    url: "/__openclaw__/mcp-app/view",
    authorization: `MCP-App ${ticket}`,
    ...params,
  });
}
function operations(ticket: string) {
  return (body: unknown) => appStatus(ticket, { method: "POST", body });
}
async function appStatus(ticket: string, params: Partial<Parameters<typeof request>[0]> = {}) {
  return (await appRequest(ticket, params)).res.statusCode;
}
const appCall = (name = "app-only") => ({ method: "tools/call", params: { name, arguments: {} } });
const resourceRead = { method: "resources/read", params: { uri: "ui://demo/state" } };
function issue(overrides: Partial<Parameters<typeof issueTicket>[0]> = {}) {
  return issueTicket({ sessionKey: "agent:main:main", view, nowMs, ...overrides });
}
function mintTicket(
  sessionKey: string,
  changes: Partial<Parameters<typeof createMcpAppStandaloneTicket>[0]["view"]> = {},
) {
  return createMcpAppStandaloneTicket({
    sessionKey,
    view: { ...view, ...changes },
    toolOperationsAuthorized: true,
  });
}

describe("MCP App standalone host", () => {
  beforeEach(resetStandaloneMcpAppTestState);

  it("negotiates fullscreen and publishes display-mode changes through the serialized host", async () => {
    const host = await createSerializedHost();
    for (const mode of ["fullscreen", "pip"]) {
      host.emit({ jsonrpc: "2.0", id: mode, method: "ui/request-display-mode", params: { mode } });
      if (mode === "fullscreen") {
        expect(host.frame.style.height).toBe("900px");
        expectMessage(
          host,
          expect.objectContaining({
            method: "ui/notifications/host-context-changed",
            params: { displayMode: "fullscreen" },
          }),
        );
      }
      expectReply(host, mode, { mode: "fullscreen" });
    }
  });

  it("mints an opaque reusable ticket and rejects tampering and expiry at HTTP admission", async () => {
    const issued = issue();
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + 2 * 60_000);
    expect(issue({ nowMs: nowMs + 1 })).toEqual(issued);
    const invoke = (ticket: string, now = nowMs) => appStatus(ticket, { now });
    expect(await invoke(issued.ticket)).toBe(200);
    expect(mocks.peekSessionMcpRuntime).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
    const suffix = issued.ticket.endsWith("x") ? "y" : "x";
    expect(await invoke(`${issued.ticket.slice(0, -1)}${suffix}`)).toBe(401);
    expect(await invoke(issued.ticket, issued.expiresAtMs + 1)).toBe(401);
  });

  it("does not downgrade requester-bound views into bearer-only standalone authority", () => {
    expect(mintTicket("agent:main:main", { requesterId: "alice" })).toBeUndefined();
  });

  it("bounds ticket lifetime by the view lease", () => {
    const shortView = { ...view, expiresAtMs: nowMs + 1_000 };
    expect(issueTicket({ sessionKey: "short", view: shortView, nowMs }).expiresAtMs).toBe(
      nowMs + 1_000,
    );
  });

  it.each([false, true])(
    "keeps GET and HEAD metadata aligned over HTTP (authorized=%s)",
    async (authorized) => {
      const path = `/__openclaw__/mcp-app${authorized ? "/view" : ""}`;
      const originalHtml = view.html;
      view.html = "<!doctype html><p>caf\u00e9 \ud83e\udd9e</p>";
      const ticket = authorized ? issue().ticket : undefined;
      const server = await startStandaloneHttp({ sandboxPort: 18_790 });
      try {
        const headers = ticket ? { Authorization: `MCP-App ${ticket}` } : undefined;
        const get = await fetch(`${server.origin}${path}`, { headers });
        const body = Buffer.from(await get.arrayBuffer());
        const head = await fetch(`${server.origin}${path}`, { method: "HEAD", headers });

        expect([get.status, head.status]).toEqual([200, 200]);
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
        await server.close();
      }
    },
  );

  it("bounds the built browser fetch when runtime function source is unavailable", async () => {
    Object.defineProperty(runStandaloneMcpAppHost, "toString", {
      configurable: true,
      value() {
        throw new Error("Runtime function source is unavailable");
      },
    });
    try {
      const timeoutError = Object.assign(new Error("timed out"), { name: "TimeoutError" });
      const initialSignal = AbortSignal.abort(timeoutError);
      const initialBody = createDeferred<unknown>();
      const host = await createSerializedHost({ initialBody, initialSignal });
      initialBody.reject(timeoutError);
      await vi.waitFor(() =>
        expect(host.replaceChildren).toHaveBeenCalledWith(
          expect.objectContaining({ textContent: "MCP App view timed out; reload to try again" }),
        ),
      );
      expect(host.timeout).toHaveBeenCalledWith(30_000);
      expect(host.fetch).toHaveBeenCalledWith(
        "/__openclaw__/mcp-app/view",
        expect.objectContaining({ signal: initialSignal }),
      );
    } finally {
      Reflect.deleteProperty(runStandaloneMcpAppHost, "toString");
    }
  });

  it("returns capabilities only for handlers installed on the live view", async () => {
    const issued = issue();
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
    const readOnly = issue({ toolOperationsAuthorized: false });
    const payload = await appRequest(readOnly.ticket);
    expect(JSON.parse(String(payload.end.mock.calls[0]?.[0]))).toHaveProperty("serverTools", false);
    expect(await appStatus(issued.ticket)).toBe(200);
    for (const replacement of [null, { ...runtime, sessionId: "runtime-replaced" }]) {
      mocks.peekSessionMcpRuntime.mockReturnValue(replacement);
      expect(await appStatus(issued.ticket)).toBe(401);
    }
    mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
    for (const replacement of [
      { ...view, viewId: "mcp-app-replaced" },
      { ...view, sessionId: "runtime-replaced" },
    ]) {
      mocks.getMcpAppViewLease.mockReturnValue(replacement);
      expect(await appStatus(issued.ticket)).toBe(401);
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

  it.each(["closed", "suspended", "failed"])(
    "does not revive a %s host on pageshow",
    async (phase) => {
      const host = await createSerializedHost(phase === "failed" ? { operationStatus: 401 } : {});
      const send = (id: number) =>
        phase === "closed"
          ? host.emit({ jsonrpc: "2.0", id, method: "resources/read", params: {} })
          : call(host, id);
      send(1);
      expect(host.operations).toHaveLength(1);
      if (phase === "failed") {
        host.operations[0]!.result.resolve("rejected");
        await vi.waitFor(() => expect(host.frame.remove).toHaveBeenCalledOnce());
      }
      host.pagehide(phase !== "closed");
      expect(host.operations[0]!.signal?.aborted).toBe(true);
      if (phase === "suspended") {
        host.operations[0]!.result.resolve("late result");
        await settle();
        expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
      }
      host.pageshow(true);
      if (phase === "suspended") {
        expect(host.reload).toHaveBeenCalledOnce();
        host.pageshow(true);
        expect(host.reload).toHaveBeenCalledOnce();
      } else {
        expect(host.reload).not.toHaveBeenCalled();
      }
      send(2);
      expect(host.operations).toHaveLength(1);
      if (phase !== "suspended") {
        host.operations[0]!.result.resolve("late result");
        await settle();
      }
      expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    },
  );

  it("keeps an active host callable after a persisted pageshow without reload", async () => {
    const host = await createSerializedHost();
    host.pageshow(true);
    expect(host.reload).not.toHaveBeenCalled();
    call(host, "live");
    expect(host.operations).toHaveLength(1);
    host.operations[0]!.result.resolve("live result");
    await vi.waitFor(() => expectReply(host, "live", "live result"));
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
      expect(operation.signal).toMatchObject({ aborted: true, reason: { name: "AbortError" } });
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
    expectMessage(host, { jsonrpc: "2.0", id: 1, method: "ui/resource-teardown", params: {} });
    host.emit({ jsonrpc: "2.0", id: 1, result: {} });
    expect(host.frame.remove).toHaveBeenCalledOnce();
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    host.operations[0]!.result.resolve("late result");
    await settle();
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it("finishes an existing call and async teardown save before unmount", async () => {
    const host = await createSerializedHost();
    try {
      call(host, "existing");
      host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
      expectMessage(host, { jsonrpc: "2.0", id: 1, method: "ui/resource-teardown", params: {} });
      expect(host.frame.remove).not.toHaveBeenCalled();
      expect(host.operations[0]!.signal?.aborted).toBe(false);
      host.operations[0]!.result.resolve("existing saved");
      await vi.waitFor(() => expectReply(host, "existing", "existing saved"));
      call(host, "save");
      expect(host.operations).toHaveLength(2);
      const save = host.operations.at(-1)!;
      expect(save.signal?.aborted).toBe(false);
      expect(host.frame.remove).not.toHaveBeenCalled();
      save.result.resolve("cleanup saved");
      await vi.waitFor(() => expectReply(host, "save", "cleanup saved"));
      host.emit({ jsonrpc: "2.0", id: 1, result: {} });
      expect(host.frame.remove).toHaveBeenCalledOnce();
      host.timers[0]!.run();
      expect(host.frame.remove).toHaveBeenCalledOnce();
    } finally {
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
    const issued = issue();
    const invoke = operations(issued.ticket);

    expect(await invoke(appCall())).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledWith("demo", "app-only", {});
    expect(await invoke(resourceRead)).toBe(200);
    expect(runtime.readResource).toHaveBeenCalledWith("demo", "ui://demo/state");

    for (const name of ["model-only", "not-allowed", "cross-only"]) {
      expect(await invoke(appCall(name))).toBe(403);
    }
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeLease).toHaveBeenCalled();
    expect(mocks.completeRetirement).toHaveBeenCalledWith(runtime);
  });

  it.each(["read-only", "unbound", "rejected-authority"])(
    "denies server operations for a %s view",
    async (mode) => {
      Object.assign(
        view,
        mode === "read-only"
          ? { readOnly: true }
          : mode === "unbound"
            ? { allowedAppToolNames: undefined }
            : {
                authorizeAppInteraction: async () => {
                  throw new Error("App interaction authority unavailable");
                },
              },
      );
      const issued = issue();
      const invoke = operations(issued.ticket);
      if (mode !== "unbound") {
        const payload = await appRequest(issued.ticket);
        expect(payload.res.statusCode).toBe(200);
        expect(JSON.parse(String(payload.end.mock.calls[0]?.[0]))).toMatchObject({
          serverResources: false,
        });
      } else {
        expect(await invoke({ method: "tools/list", params: {} })).toBe(403);
      }
      expect(await invoke(appCall())).toBe(403);
      expect(await invoke(resourceRead)).toBe(403);
      expect(runtime.callTool).not.toHaveBeenCalled();
      expect(runtime.readResource).not.toHaveBeenCalled();
    },
  );

  it("revalidates expiry and enforces request concurrency through the ticket boundary", async () => {
    const issued = issue();
    const invoke = (now: number) =>
      appStatus(issued.ticket, {
        method: "POST",
        now,
        body: { method: "resources/list", params: {} },
      });
    view.activeRequests = 4;
    expect(await appStatus(issued.ticket, { now: nowMs })).toBe(429);
    expect(await invoke(nowMs)).toBe(403);
    view.activeRequests = 0;
    expect(await invoke(issued.expiresAtMs + 1)).toBe(401);

    let currentTime = nowMs;
    const clock = () => currentTime;
    expect(
      await appStatus(issued.ticket, {
        method: "POST",
        clock,
        beforeBody: () => {
          currentTime = issued.expiresAtMs + 1;
        },
        body: { method: "resources/list", params: {} },
      }),
    ).toBe(401);
    expect(runtime.listResources).not.toHaveBeenCalled();
  });

  it("is path-scoped and rejects malformed operations", async () => {
    const issued = issue();
    expect((await request({ url: "/__openclaw__/mcp-app", method: "POST" })).res.statusCode).toBe(
      404,
    );
    expect((await request({ url: "/__openclaw__/mcp-app/other" })).handled).toBe(false);
    expect(
      await appStatus(issued.ticket, {
        method: "POST",
        body: { method: "gateway.call", params: {} },
      }),
    ).toBe(400);
  });
});

describe("standalone channel launch", () => {
  const publish = (origin = "https://node.tailnet.ts.net", mode: "serve" | "funnel" = "serve") =>
    prepareTailscalePublishedOrigin({ origin, mode });
  const clear = () => publish("https://reset.test")();
  const materialize = () =>
    materializeMcpAppChannelPresentation({
      sessionKey: "agent:main:main",
      view: { viewId: view.viewId },
    });
  beforeEach(() => {
    resetStandaloneMcpAppTestState();
    clear();
  });
  afterEach(clear);

  it("stores one lifecycle-owned Serve or Funnel snapshot", () => {
    const clearServe = publish();
    const clearFunnel = publish("https://public.example.ts.net/", "funnel");
    expect(getTailscalePublishedOrigin()).toMatchObject({
      origin: "https://public.example.ts.net",
      mode: "funnel",
    });
    clearServe();
    expect(getTailscalePublishedOrigin()).toBeDefined();
    clearFunnel();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
  });

  it.each(["http://node.test", "https://%75@node.test", "https://node.test/path"])(
    "rejects unsafe origin %s",
    (origin) => expect(() => publish(origin)).toThrow("absolute HTTPS origin"),
  );

  it("emits only a typed launch action with a usable tool-authorized opaque ticket", async () => {
    publish();
    const presentation = materialize();
    expect(JSON.stringify(presentation)).not.toContain(view.html);
    const button = presentation?.blocks.find((block) => block.type === "buttons")?.buttons[0];
    expect(button?.label).toBe("Open app");
    const action = button?.action;
    expect(action).toEqual({
      type: "web-app",
      url: expect.stringMatching(
        /^https:\/\/node\.tailnet\.ts\.net\/__openclaw__\/mcp-app#v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u,
      ),
    });
    if (action?.type !== "web-app" || !action.url) {
      throw new Error("missing app launch action");
    }
    expect(await operations(new URL(action.url).hash.slice(1))(appCall())).toBe(200);
  });

  it.each([
    ["missing origin", clear],
    ["missing view", () => mocks.getMcpAppViewLease.mockReturnValue(undefined)],
    [
      "expired view",
      () => mocks.getMcpAppViewLease.mockReturnValue({ ...view, expiresAtMs: nowMs }),
    ],
    [
      "ticket capacity",
      () => {
        for (let index = 0; index < 256; index++) {
          expect(mintTicket(`capacity:${index}`, { viewId: `capacity:${index}` })).toBeDefined();
        }
      },
    ],
  ])("omits the action for %s", (_name, arrange) => {
    publish();
    arrange();
    expect(materialize()).toBeUndefined();
  });
});
