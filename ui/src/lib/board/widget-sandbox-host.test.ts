import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../../../packages/gateway-protocol/src/schema/canvas.ts";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../../test/helpers/gateway-integration-fixtures.ts";
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
function channel() {
  const value = new MessageChannel();
  onTestFinished(() => value.port2.close());
  value.port2.start();
  return value;
}
const acknowledge = (port: MessagePort, ticket: string) =>
  port.postMessage({ type: "openclaw:widget-host-init-ack", ticket }, []);
function scopedFetch(matches: (url: string) => boolean, fetchMock: typeof fetch) {
  const original = globalThis.fetch.bind(globalThis);
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return matches(url) ? fetchMock(input, init) : original(input, init);
  };
}
function nextMessage(port: MessagePort, matches: (event: MessageEvent) => boolean) {
  return new Promise<MessageEvent>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (matches(event)) {
        port.removeEventListener("message", listener);
        resolve(event);
      }
    };
    port.addEventListener("message", listener);
  });
}
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
    onPending: vi.fn(),
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
  const messages: unknown[] = [];
  const port = async () => {
    const { port1, port2 } = channel();
    port2.addEventListener("message", (event) => messages.push(event.data));
    const initialized = nextMessage(
      port2,
      (event) =>
        event.data?.type === "openclaw:widget-host-init" && typeof event.data.ticket === "string",
    );
    send({ type: "openclaw:widget-bridge-port-offer" }, [port1]);
    acknowledge(port2, (await initialized).data.ticket);
    return port2;
  };
  return { ...options, frame, host, fetchMock, post, send, notify, ready, update, port, messages };
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
  const response = nextMessage(
    port,
    (event) => event.data?.type === "openclaw:widget-bridge-response" && event.data.id === data.id,
  );
  port.postMessage(data, []);
  return (await response).data as Record<string, unknown>;
}
const reply = (
  port: MessagePort,
  data: Record<string, unknown>,
  expected: Record<string, unknown> = { ok: true },
) => expect(sendRequest(port, data)).resolves.toMatchObject(expected);
const rejectRequest = (port: MessagePort, data: Record<string, unknown>, error: string) =>
  reply(port, data, { ok: false, error });
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("BoardWidgetSandboxHost", () => {
  it.each(["disconnected", "passive"])(
    "loads %s documents without accepting bridge requests",
    async (mode) => {
      const c = client();
      const f = await readyHost({
        client: c,
        connected: mode !== "disconnected",
        bridgeEnabled: mode !== "passive",
      });
      const { port1, port2 } = channel();
      const close = vi.spyOn(port1, "close");
      f.send({ type: "openclaw:widget-bridge-port-offer" }, [port1]);
      if (mode === "passive") {
        expect(close).toHaveBeenCalledOnce();
      } else {
        await rejectRequest(port2, request("before-hello"), "Gateway unavailable");
      }
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(c.request).not.toHaveBeenCalled();
    },
  );
  it("binds document delivery and receipts to proxy readiness", async () => {
    const c = promptClient();
    const f = createHost({
      client: c,
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
    rendered("stale-document");
    rendered(renderId, window);
    rendered(renderId, f.frame.contentWindow, "https://other.example");
    expect(f.onRendered).not.toHaveBeenCalled();
    rendered();
    rendered();
    expect(f.onRendered).toHaveBeenCalledOnce();
    const data = prompt("prompt-request", "Injected");
    f.send(data);
    await Promise.resolve();
    expect(c.request).not.toHaveBeenCalled();
    const port = await f.port();
    f.send({ type: "openclaw:widget-bridge-ready" });
    expect(f.messages).toContainEqual({
      type: "openclaw:widget-host-init",
      ticket: "ticket",
      controlUiBaseUrl: "https://control.example/openclaw",
    });
    port.postMessage(data, []);
    await vi.waitFor(() =>
      expect(c.request).toHaveBeenCalledWith("board.prompt.authorize", { ticket: "ticket" }),
    );
    f.host.reset();
    rendered();
    expect(f.onRendered).toHaveBeenCalledOnce();
  });
  it("reports transient document failures separately from authorization", async () => {
    const f = createHost({ client: client() }, htmlFetch("unavailable", { status: 503 }));
    f.ready();
    await vi.waitFor(() => expect(f.onLoadFailed).toHaveBeenCalledWith(widget()));
    expect(f.onError).not.toHaveBeenCalled();
  });
  it("scopes prompt limits by board source and view generation", async () => {
    const prefix = "session-" + crypto.randomUUID();
    let activeFrame: HTMLIFrameElement | null = null;
    const focus = vi.spyOn(document, "activeElement", "get").mockImplementation(() => activeFrame);
    onTestFinished(() => focus.mockRestore());
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
    const port = await f.port();
    const response = nextMessage(port, (event) => event.data?.id === "in-flight");
    const renewal = nextMessage(port, (event) => event.data?.ticket === "renewed-ticket");
    port.postMessage(request("in-flight"), []);
    await called(c.request);
    f.update({
      widget: widget({ viewTicket: "renewed-ticket" }),
      resolveFrameUrl: () => "/widget?bt=renewed-ticket",
    });
    port.postMessage(state("before-ack", "renewing"), []);
    await called(c.request, 2);
    acknowledge(port, (await renewal).data.ticket);
    pending.resolve({ status: "healthy" });
    expect((await response).data).toMatchObject({ id: "in-flight", ok: true });
    port.postMessage(state("after-ack", "renewed", "renewed-ticket"), []);
    await called(c.request, 3);
    expect(c.request.mock.calls.slice(1)).toEqual([
      ["board.event", { ticket: "ticket", payload: { phase: "renewing" } }],
      ["board.event", { ticket: "renewed-ticket", payload: { phase: "renewed" } }],
    ]);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });
  it.each(["replaced", "reconnected"])(
    "cancels in-flight requests when the client is %s",
    async (change) => {
      const pending = Promise.withResolvers<unknown>();
      const old = { request: vi.fn(async () => await pending.promise) };
      const next = change === "reconnected" ? old : client();
      const f = await readyHost({ client: old, resolveFrameUrl: () => "/widget?bt=ticket" });
      const port = await f.port();
      port.postMessage(request("old-client"), []);
      await called(old.request);
      if (change === "reconnected") {
        f.update({ connected: false, documentActive: false });
      }
      f.update({ client: next, connected: true });
      await vi.waitFor(() =>
        expect(f.messages).toContainEqual({
          type: "openclaw:widget-bridge-response",
          id: "old-client",
          ok: false,
          error: "Gateway connection changed",
        }),
      );
      pending.resolve({ private: "old-context" });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.messages).not.toContainEqual(
        expect.objectContaining({ id: "old-client", ok: true }),
      );
      next.request.mockClear();
      next.request.mockResolvedValue({ ok: true });
      await reply(port, state("new-client", "reconnected"), { id: "new-client", ok: false });
      expect(next.request).not.toHaveBeenCalled();
      const renewal = nextMessage(
        port,
        (event) =>
          event.data?.type === "openclaw:widget-host-init" &&
          event.data.ticket === "renewed-ticket",
      );
      f.update({ client: next, widget: widget({ viewTicket: "renewed-ticket" }) });
      await renewal;
      acknowledge(port, "renewed-ticket");
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
  it.each(["session", "generation", "revision", "CSP"] as const)(
    "reloads %s identity",
    async (change) => {
      const pending = Promise.withResolvers<unknown>();
      const c = { request: vi.fn(() => pending.promise) };
      const wide = SANDBOX_URL + "?csp=wide",
        narrow = SANDBOX_URL + "?csp=narrow";
      const sources = new Set([
        "https://gateway.example/widget",
        `https://gateway.example/${change === "session" ? "other" : "widget"}`,
      ]);
      const fetchMock = htmlFetch();
      const f = await readyHost(
        {
          sandboxUrl: change === "CSP" ? wide : SANDBOX_URL,
          client: c,
        },
        scopedFetch((url) => sources.has(url), fetchMock),
      );
      const port = await f.port();
      port.postMessage(request("old-request"), []);
      await called(c.request);
      f.post.mockClear();
      f.update({
        sandboxUrl: change === "CSP" ? narrow : SANDBOX_URL,
        widget: widget({
          viewTicket: "next-ticket",
          ...(change === "generation" ? { viewGeneration: "b".repeat(32) } : {}),
          ...(change === "revision" ? { revision: 3 } : {}),
        }),
        resolveFrameUrl: () => (change === "session" ? "/other" : "/widget"),
      });
      pending.resolve({ sensitive: "old grant result" });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.messages).not.toContainEqual(expect.objectContaining({ id: "old-request" }));
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
    },
  );
  it("retains readiness, resumes interrupted loading, and preserves the bridge across inactivity", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<Response>();
    const c = { request: vi.fn(async () => ({ resumed: true })) };
    const fetchMock = htmlFetch().mockImplementationOnce(() => pending.promise);
    const f = createHost(
      { client: c },
      scopedFetch((url) => url === "https://gateway.example/widget", fetchMock),
    );
    const retained = f.host.frame;
    const reload = vi.spyOn(f.frame, "src", "set");
    f.host.setActive(false);
    f.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    f.host.setActive(true);
    await called(fetchMock);
    f.host.setActive(false);
    pending.resolve(new Response("<!doctype html><p>stale</p>"));
    await Promise.resolve();
    expect(f.onLoaded).not.toHaveBeenCalled();
    f.host.setActive(true);
    await called(f.onLoaded);
    const port = await f.port();
    f.host.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejectRequest(port, request("inactive"), "Widget inactive");
    expect(c.request).not.toHaveBeenCalled();
    f.host.setActive(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.host.frame).toBe(retained);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(f.onReadyTimeout).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await reply(port, request("resumed"), { ok: true, result: { resumed: true } });
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
    onTestFinished(() => (server.listening ? closeHttpServer(server) : undefined));
    const sourceOrigin = await listenLoopback(server);
    const rejected = Promise.withResolvers<void>();
    const onError = vi.fn<(error: unknown) => void>(() => rejected.resolve());
    const f = createHost({ onError, sourceOrigin }, null);
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
describe("document timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  it.each(["headers", "body", "render"] as const)("times out %s", async (phase) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (phase === "render") {
        return new Response("<p>Waiting for a resource</p>");
      }
      const signal = init?.signal;
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("request aborted")));
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<!doctype html>"));
            signal?.addEventListener("abort", () => controller.error(new Error("body aborted")));
          },
        }),
      );
    });
    const f = createHost({ onRendered: phase === "render" ? vi.fn() : undefined }, fetchMock);
    f.ready();
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
    const fetchMock = vi.fn(async () => {
      if (phase === "document") {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 15_000);
        });
      }
      return new Response("<p>Slow success</p>");
    });
    const onError = vi.fn();
    const frame = document.createElement("iframe");
    frame.src = SANDBOX_URL;
    const f = createHost(
      {
        frame,
        onError,
        onLoadFailed: onError,
        onUnauthorized: onError,
        onReadyTimeout: onError,
        onRendered: phase === "render" ? vi.fn() : undefined,
      },
      fetchMock,
    );
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
    const f = createHost({}, fetchMock);
    f.ready();
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
  });
});
