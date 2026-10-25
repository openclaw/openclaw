import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../../../packages/gateway-protocol/src/schema/canvas.ts";
import type { BoardWidget } from "./types.ts";
import { BoardWidgetSandboxHost } from "./widget-sandbox-host.ts";
import { createBoardWidget } from "./widget.test-support.ts";
const SANDBOX_ORIGIN = "https://sandbox.example";
const SANDBOX_URL = SANDBOX_ORIGIN + "/mcp-app-sandbox";
type HostOptions = ConstructorParameters<typeof BoardWidgetSandboxHost>[0];
const widget = (overrides: Partial<BoardWidget> = {}): BoardWidget =>
  createBoardWidget({
    name: "weather",
    grantState: "granted",
    revision: 2,
    viewTicket: "ticket",
    viewGeneration: "a".repeat(32),
    ...overrides,
  });
const htmlFetch = (html = "<!doctype html><p>weather</p>", init?: ResponseInit) =>
  vi.fn<typeof fetch>(async () => new Response(html, init));
const client = () => ({ request: vi.fn(async () => ({ ok: true })) });
const promptClient = () => ({
  request: vi.fn(async (method: string) =>
    method === "board.prompt.authorize" ? { confirmationRequired: false } : { ok: true },
  ),
});
const called = (mock: unknown, count = 1) =>
  vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
function createHost(
  overrides: Partial<HostOptions> = {},
  fetchMock: typeof fetch | null = htmlFetch(),
) {
  const frame = overrides.frame ?? document.createElement("iframe");
  document.body.append(frame);
  if (fetchMock) {
    vi.stubGlobal("fetch", fetchMock);
  }
  const options: HostOptions = {
    frame,
    widget: widget(),
    documentActive: true,
    sandboxOrigin: SANDBOX_ORIGIN,
    sandboxUrl: SANDBOX_URL,
    sourceOrigin: "https://gateway.example",
    resolveFrameUrl: () => "/widget",
    confirmPrompt: () => true,
    onFrameUrl: vi.fn(),
    onLoadFailed: vi.fn(),
    onUnauthorized: vi.fn(),
    onReadyTimeout: vi.fn(),
    onLoaded: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const host = new BoardWidgetSandboxHost(options);
  onTestFinished(() => host.dispose());
  const send = (
    data: unknown,
    ports: MessagePort[] = [],
    source = frame.contentWindow,
    origin = SANDBOX_ORIGIN,
  ) => host.handleMessage(new MessageEvent("message", { source, origin, data, ports }));
  const notify = (method: string, params: Record<string, unknown>) =>
    send({ method: "ui/notifications/sandbox-" + method, params });
  const ready = (sandboxUrl = options.sandboxUrl) => notify("proxy-ready", { sandboxUrl });
  const update = (next: Partial<HostOptions>) => host.update({ ...options, ...next });
  const port = async (onMessage?: (event: MessageEvent) => void) => {
    const channel = new MessageChannel();
    onTestFinished(() => channel.port2.close());
    let adopted = false;
    const initialized = new Promise<void>((resolve) => {
      channel.port2.addEventListener("message", (event) => {
        onMessage?.(event);
        if (
          !adopted &&
          event.data?.type === "openclaw:widget-host-init" &&
          typeof event.data.ticket === "string"
        ) {
          adopted = true;
          channel.port2.postMessage(
            { type: "openclaw:widget-host-init-ack", ticket: event.data.ticket },
            [],
          );
          resolve();
        }
      });
    });
    channel.port2.start();
    send({ type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
    await initialized;
    return channel.port2;
  };
  return { ...options, options, frame, host, fetchMock, post, send, notify, ready, update, port };
}
async function readyHost(...args: Parameters<typeof createHost>) {
  const f = createHost(...args);
  f.ready();
  await called(f.onLoaded);
  return f;
}
const request = (
  id: string,
  method = "data.read",
  params: Record<string, unknown> = { bindingId: "health" },
  ticket = "ticket",
) => ({ type: "openclaw:widget-bridge-request", id, method, params, ticket });
const state = (id: string, phase: string, ticket = "ticket") =>
  request(id, "state.emit", { payload: { phase } }, ticket);
const prompt = (id: string, text: string) => request(id, "prompt.send", { text });
async function sendRequest(port: MessagePort, data: Record<string, unknown>) {
  return await new Promise<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "openclaw:widget-bridge-response" || event.data.id !== data.id) {
        return;
      }
      port.removeEventListener("message", listener);
      resolve(event.data as Record<string, unknown>);
    };
    port.addEventListener("message", listener);
    port.postMessage(data, []);
  });
}
const reply = (
  port: MessagePort,
  data: Record<string, unknown>,
  expected: Record<string, unknown> = { ok: true },
) => expect(sendRequest(port, data)).resolves.toMatchObject(expected);
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("BoardWidgetSandboxHost", () => {
  it("loads before connecting without accepting bridge requests", async () => {
    const c = client();
    const f = await readyHost({ connected: false, client: c });
    const channel = new MessageChannel();
    onTestFinished(() => channel.port2.close());
    channel.port2.start();
    f.send({ type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
    await reply(channel.port2, request("before-hello"), {
      ok: false,
      error: "Gateway unavailable",
    });
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.onLoaded).toHaveBeenCalledOnce();
    expect(c.request).not.toHaveBeenCalled();
  });
  it("binds document delivery and receipts to proxy readiness", async () => {
    const f = createHost({
      client: client(),
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      onRendered: vi.fn(),
      controlUiBaseUrl: "https://control.example/openclaw",
    });
    await called(f.fetchMock);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.onLoaded).not.toHaveBeenCalled();
    f.ready();
    await called(f.onLoaded);
    expect(f.fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/__openclaw__/board/weather?bt=ticket",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
    expect(f.post).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<!doctype html><p>weather</p>", renderId: expect.any(String) },
      },
      SANDBOX_ORIGIN,
    );
    const { renderId } = f.post.mock.calls[0]![0].params as { renderId: string };
    const rendered = (id = renderId, source = f.frame.contentWindow, origin = SANDBOX_ORIGIN) =>
      f.send(
        { method: "ui/notifications/sandbox-resource-loaded", params: { renderId: id } },
        [],
        source,
        origin,
      );
    expect(f.onRendered).not.toHaveBeenCalled();
    rendered("stale-document");
    rendered(renderId, window);
    rendered(renderId, f.frame.contentWindow, "https://other.example");
    expect(f.onRendered).not.toHaveBeenCalled();
    rendered();
    rendered();
    expect(f.onRendered).toHaveBeenCalledOnce();
    const messages = vi.fn();
    await f.port(messages);
    f.send({ type: "openclaw:widget-bridge-ready" });
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: "openclaw:widget-host-init",
          ticket: "ticket",
          controlUiBaseUrl: "https://control.example/openclaw",
        },
      }),
    );
    f.host.reset();
    rendered();
    expect(f.onRendered).toHaveBeenCalledOnce();
  });
  it("delivers passive previews without accepting a capability port", async () => {
    const c = client();
    const f = await readyHost({
      client: c,
      bridgeEnabled: false,
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
    });
    const channel = new MessageChannel();
    onTestFinished(() => channel.port2.close());
    const close = vi.spyOn(channel.port1, "close");
    f.send({ type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
    expect(close).toHaveBeenCalledOnce();
    expect(c.request).not.toHaveBeenCalled();
  });
  it("reports transient document failures separately from authorization", async () => {
    const f = createHost(
      {
        client: client(),
        resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      },
      htmlFetch("unavailable", { status: 503 }),
    );
    f.ready();
    await vi.waitFor(() => expect(f.onLoadFailed).toHaveBeenCalledWith(widget()));
    expect(f.onError).not.toHaveBeenCalled();
  });
  it("drops responses after document replacement", async () => {
    const pending = Promise.withResolvers<unknown>();
    const c = { request: vi.fn(async () => await pending.promise) };
    const f = await readyHost({ client: c });
    const port = await f.port();
    const response = vi.fn();
    port.addEventListener("message", response);
    f.post.mockClear();
    port.postMessage(request("old-request"), []);
    await called(c.request);
    f.update({ widget: widget({ revision: 3, viewTicket: "next-ticket" }) });
    pending.resolve({ sensitive: "old grant result" });
    await Promise.resolve();
    await Promise.resolve();
    expect(response).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      SANDBOX_ORIGIN,
    );
  });
  it("accepts bridge requests only on the wrapper-owned private port", async () => {
    const c = promptClient();
    const f = createHost({ client: c });
    f.ready();
    await called(fetch);
    const data = prompt("prompt-request", "Injected");
    f.send(data);
    await Promise.resolve();
    expect(c.request).not.toHaveBeenCalled();
    (await f.port()).postMessage(data, []);
    await vi.waitFor(() =>
      expect(c.request).toHaveBeenCalledWith("board.prompt.authorize", { ticket: "ticket" }),
    );
  });
  it("scopes prompt limits by board source and view generation", async () => {
    const prefix = "session-" + crypto.randomUUID();
    let activeFrame: HTMLIFrameElement | null = null;
    Object.defineProperty(document, "activeElement", {
      get: () => activeFrame,
      configurable: true,
    });
    onTestFinished(() => {
      delete (document as unknown as Record<string, unknown>).activeElement;
    });
    const setup = async (session: string, generation: string) => {
      const f = await readyHost({
        widget: widget({ viewGeneration: generation }),
        client: promptClient(),
        resolveFrameUrl: () => "/__openclaw__/board/" + session + "/weather/index.html?bt=ticket",
      });
      f.frame.checkVisibility = () => true;
      activeFrame = f.frame;
      return await f.port();
    };
    const first = await setup(prefix + "-a", "a".repeat(32));
    for (let i = 0; i < 10; i += 1) {
      await reply(first, prompt("first-" + i, "Prompt " + i));
    }
    const other = await setup(prefix + "-b", "a".repeat(32));
    await reply(other, prompt("other-session", "Independent session"));
    const recreated = await setup(prefix + "-a", "b".repeat(32));
    await reply(recreated, prompt("recreated-view", "Independent generation"));
  });
  it("keeps the adopted ticket valid until renewal is acknowledged", async () => {
    const pending = Promise.withResolvers<unknown>();
    const c = {
      request: vi.fn(async (method: string) =>
        method === "board.data.read" ? await pending.promise : { ok: true },
      ),
    };
    const f = await readyHost({ client: c, resolveFrameUrl: () => "/widget?bt=ticket" });
    const responses: unknown[] = [];
    let renewalTicket = "";
    const port = await f.port((event) => {
      if (event.data?.type === "openclaw:widget-host-init") {
        renewalTicket = event.data.ticket;
      } else if (event.data?.type === "openclaw:widget-bridge-response") {
        responses.push(event.data);
      }
    });
    port.postMessage(request("in-flight"), []);
    await called(c.request);
    f.update({
      widget: widget({ viewTicket: "renewed-ticket" }),
      resolveFrameUrl: () => "/widget?bt=renewed-ticket",
    });
    port.postMessage(state("before-ack", "renewing"), []);
    await called(c.request, 2);
    await vi.waitFor(() => expect(renewalTicket).toBe("renewed-ticket"));
    port.postMessage({ type: "openclaw:widget-host-init-ack", ticket: renewalTicket }, []);
    pending.resolve({ status: "healthy" });
    await vi.waitFor(() =>
      expect(responses).toContainEqual(expect.objectContaining({ id: "in-flight", ok: true })),
    );
    port.postMessage(state("after-ack", "renewed", "renewed-ticket"), []);
    await called(c.request, 3);
    expect(c.request.mock.calls.slice(1)).toEqual([
      ["board.event", { ticket: "ticket", payload: { phase: "renewing" } }],
      ["board.event", { ticket: "renewed-ticket", payload: { phase: "renewed" } }],
    ]);
  });
  it.each(["replaced", "reconnected"])(
    "cancels in-flight requests when the client is %s",
    async (change) => {
      const pending = Promise.withResolvers<unknown>();
      const old = { request: vi.fn(async () => await pending.promise) };
      const next = change === "reconnected" ? old : client();
      const f = await readyHost({ client: old, resolveFrameUrl: () => "/widget?bt=ticket" });
      const responses: unknown[] = [];
      const port = await f.port((event) => {
        if (event.data?.type === "openclaw:widget-bridge-response") {
          responses.push(event.data);
        }
      });
      port.postMessage(request("old-client"), []);
      await called(old.request);
      if (change === "reconnected") {
        f.update({ connected: false, documentActive: false });
      }
      f.update({ client: next, connected: true });
      await vi.waitFor(() =>
        expect(responses).toContainEqual({
          type: "openclaw:widget-bridge-response",
          id: "old-client",
          ok: false,
          error: "Gateway connection changed",
        }),
      );
      pending.resolve({ private: "old-context" });
      await Promise.resolve();
      await Promise.resolve();
      expect(responses).not.toContainEqual(expect.objectContaining({ id: "old-client", ok: true }));
      next.request.mockClear();
      next.request.mockResolvedValue({ ok: true });
      await reply(port, state("new-client", "reconnected"), {
        id: "new-client",
        ok: false,
      });
      expect(next.request).not.toHaveBeenCalled();
      const renewal = new Promise<void>((resolve) => {
        port.addEventListener("message", (event) => {
          if (
            event.data?.type === "openclaw:widget-host-init" &&
            event.data.ticket === "renewed-ticket"
          ) {
            port.postMessage(
              { type: "openclaw:widget-host-init-ack", ticket: "renewed-ticket" },
              [],
            );
            resolve();
          }
        });
      });
      f.update({ client: next, widget: widget({ viewTicket: "renewed-ticket" }) });
      await renewal;
      await reply(port, state("revalidated", "reconnected", "renewed-ticket"), {
        id: "revalidated",
        ok: true,
      });
      expect(next.request).toHaveBeenCalledWith("board.event", {
        ticket: "renewed-ticket",
        payload: { phase: "reconnected" },
      });
    },
  );
  it.each(["session", "generation", "CSP"] as const)("reloads %s identity", async (change) => {
    const path = (session = "a", ticket = "ticket") =>
      "/__openclaw__/board/session-" + session + "/weather/index.html?bt=" + ticket;
    const wide = SANDBOX_URL + "?csp=wide",
      narrow = SANDBOX_URL + "?csp=narrow";
    const sources = new Set(
      [path(), path(change === "session" ? "b" : "a")].map(
        (value) => "https://gateway.example" + value.split("?")[0],
      ),
    );
    const originalFetch = globalThis.fetch.bind(globalThis),
      fetchMock = htmlFetch();
    const f = await readyHost(
      {
        sandboxUrl: change === "CSP" ? wide : SANDBOX_URL,
        client: client(),
        resolveFrameUrl: () => path(),
      },
      (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return sources.has(url.split(/[?#]/u, 1)[0]!)
          ? fetchMock(input, init)
          : originalFetch(input, init);
      },
    );
    f.update({
      widget: widget({ viewTicket: "renewed-ticket" }),
      resolveFrameUrl: () => path("a", "renewed-ticket"),
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    f.post.mockClear();
    f.update({
      sandboxUrl: change === "CSP" ? narrow : SANDBOX_URL,
      widget: widget({
        viewTicket: "next-ticket",
        ...(change !== "session" ? { viewGeneration: "b".repeat(32) } : {}),
        ...(change === "CSP" ? { revision: 3 } : {}),
      }),
      resolveFrameUrl: () => path(change === "session" ? "b" : "a", "next-ticket"),
    });
    expect(f.post).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      SANDBOX_ORIGIN,
    );
    await called(fetchMock, 2);
    if (change === "CSP") {
      expect(f.post).not.toHaveBeenCalled();
      f.ready(wide);
      await Promise.resolve();
      expect(f.post).not.toHaveBeenCalled();
      f.ready(narrow);
      await called(f.onLoaded, 2);
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({ method: "ui/notifications/sandbox-resource-ready" }),
        SANDBOX_ORIGIN,
      );
    }
  });
  it("records one-shot proxy readiness while inactive", async () => {
    vi.useFakeTimers();
    const f = createHost();
    const reload = vi.spyOn(f.frame, "src", "set");
    f.host.setActive(false);
    f.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    f.host.setActive(true);
    await called(f.onLoaded);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
  it("retains the loaded frame and private bridge while inactive", async () => {
    vi.useFakeTimers();
    const c = { request: vi.fn(async () => ({ resumed: true })) };
    const f = await readyHost({ client: c });
    const port = await f.port();
    const retained = f.host.frame;
    const reload = vi.spyOn(f.frame, "src", "set");
    f.host.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await reply(port, request("inactive"), {
      ok: false,
      error: "Widget inactive",
    });
    expect(c.request).not.toHaveBeenCalled();
    f.host.setActive(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.host.frame).toBe(retained);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await reply(port, request("resumed"), {
      ok: true,
      result: { resumed: true },
    });
  });
  it("resumes one interrupted document load after reactivation", async () => {
    const pending = Promise.withResolvers<Response>();
    const source = "https://gateway.example/widget";
    const originalFetch = globalThis.fetch.bind(globalThis);
    let sourceFetches = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if ((input instanceof Request ? input.url : String(input)) !== source) {
        return await originalFetch(input, init);
      }
      sourceFetches += 1;
      return sourceFetches === 1
        ? await pending.promise
        : new Response("<!doctype html><p>resumed</p>");
    });
    const f = createHost({}, fetchMock);
    f.ready();
    await vi.waitFor(() => expect(sourceFetches).toBe(1));
    f.host.setActive(false);
    pending.resolve(new Response("<!doctype html><p>stale</p>"));
    await Promise.resolve();
    expect(f.onLoaded).not.toHaveBeenCalled();
    f.host.setActive(true);
    await called(f.onLoaded);
    expect(sourceFetches).toBe(2);
  });
  it("bounds readiness retries and cancels them on disposal", async () => {
    vi.useFakeTimers();
    const f = createHost();
    f.host.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.host.setActive(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.onReadyTimeout).toHaveBeenCalledOnce();
    expect(f.frame.src).toBe("");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.frame.src).toBe(SANDBOX_URL);
    const reload = vi.spyOn(f.frame, "src", "set");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload).toHaveBeenCalledWith(SANDBOX_URL);
    expect(f.onReadyTimeout).toHaveBeenCalledTimes(2);
    f.host.dispose();
    await vi.advanceTimersByTimeAsync(34_000);
    expect(f.onReadyTimeout).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
    expect(f.onLoadFailed).not.toHaveBeenCalled();
  });
  it("cancels oversized HTTP bodies", async () => {
    const closed = Promise.withResolvers<void>();
    let count = 0;
    const server = createServer((req, res) => {
      count += 1;
      req.socket.once("close", () => closed.resolve());
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(WIDGET_HTML_MAX_UTF8_BYTES + 1),
      });
      res.write("<!doctype html><p>partial</p>");
    });
    onTestFinished(async () => {
      if (!server.listening) {
        return;
      }
      const closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closing;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const rejected = Promise.withResolvers<void>();
    const onError = vi.fn<(error: unknown) => void>(() => rejected.resolve());
    const f = createHost(
      {
        onError,
        sourceOrigin: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      },
      null,
    );
    f.ready();
    await rejected.promise;
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "widget HTML exceeds 10 MiB; regenerate a smaller widget",
      }),
    );
    expect(f.onLoaded).not.toHaveBeenCalled();
    expect(f.onLoadFailed).not.toHaveBeenCalled();
    expect(count).toBe(1);
    await closed.promise;
  });
});
function timeoutHost(waitForRender = false, deferReady = false) {
  const frame = document.createElement("iframe");
  if (deferReady) {
    frame.src = SANDBOX_URL;
  }
  const onError = vi.fn();
  const f = createHost(
    {
      frame,
      resolveFrameUrl: () => (deferReady ? "/widget" : "/widget?generation=first"),
      onLoadFailed: deferReady ? onError : vi.fn(),
      onUnauthorized: deferReady ? onError : vi.fn(),
      onReadyTimeout: deferReady ? onError : vi.fn(),
      onRendered: waitForRender ? vi.fn() : undefined,
      onPending: deferReady ? vi.fn() : undefined,
      onError,
    },
    null,
  );
  if (!deferReady) {
    f.ready();
  }
  return f;
}
describe("document timeouts", () => {
  it.each(["headers", "body", "render"] as const)("times out %s", async (phase) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (phase === "render") {
          return Promise.resolve(new Response("<p>Waiting for a resource</p>"));
        }
        const signal = init?.signal;
        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("request aborted")));
          });
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("<!doctype html>"));
                signal?.addEventListener("abort", () =>
                  controller.error(new Error("body aborted")),
                );
              },
            }),
          ),
        );
      }),
    );
    const f = timeoutHost(phase === "render");
    await vi.advanceTimersByTimeAsync(30_000);
    if (phase === "render") {
      expect(f.onLoadFailed).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("did not finish loading"),
        }),
      );
    } else {
      expect(f.onLoadFailed).toHaveBeenCalledExactlyOnceWith(widget());
    }
    expect(f.onLoaded).toHaveBeenCalledTimes(phase === "render" ? 1 : 0);
  });
  it.each(["document", "proxy", "render"] as const)("permits slow %s loads", async (phase) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      if (phase === "document") {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 15_000);
        });
      }
      return new Response("<p>Slow success</p>");
    });
    vi.stubGlobal("fetch", fetchMock);
    const f = timeoutHost(phase === "render", true);
    if (phase !== "proxy") {
      f.ready();
    }
    const reload = vi.spyOn(f.frame, "src", "set");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.onPending).toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    if (phase === "proxy") {
      f.ready();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onLoaded).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    if (phase === "render") {
      const delivery = f.post.mock.calls.find(
        ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
      )![0];
      f.notify("resource-loaded", { renderId: delivery.params.renderId });
      expect(f.onRendered).toHaveBeenCalledOnce();
    }
    expect(reload).not.toHaveBeenCalled();
  });
  it.each(["generation", "client"] as const)("cancels %s loads", async (change) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchMock.mock.calls.length !== 1) {
        return Promise.resolve(new Response("<!doctype html><p>replacement</p>"));
      }
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("request aborted")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const f = timeoutHost();
    await called(fetchMock);
    f.update({
      ...(change === "generation"
        ? { widget: widget({ viewGeneration: "b".repeat(32) }) }
        : { client: client() }),
      resolveFrameUrl: () => "/widget?generation=replacement",
    });
    await called(f.onLoaded);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(f.onLoadFailed).not.toHaveBeenCalled();
    expect(f.onLoaded).toHaveBeenCalledOnce();
  });
});
