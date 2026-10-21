import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../../../packages/gateway-protocol/src/schema/canvas.ts";
import type { BoardWidget } from "./types.ts";
import { BoardWidgetSandboxHost } from "./widget-sandbox-host.ts";

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

const SANDBOX_URL = "https://sandbox.example/mcp-app-sandbox";
type HostOptions = ConstructorParameters<typeof BoardWidgetSandboxHost>[0];

function htmlFetch(html = "<!doctype html><p>weather</p>", init?: ResponseInit) {
  return vi.fn<typeof fetch>(async () => new Response(html, init));
}

function widget(): BoardWidget {
  return {
    name: "weather",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    revision: 2,
    viewTicket: "ticket",
    viewGeneration: "a".repeat(32),
  };
}

function hostOptions(frame: HTMLIFrameElement, overrides: Partial<HostOptions> = {}): HostOptions {
  return {
    frame,
    widget: widget(),
    documentActive: true,
    sandboxOrigin: "https://sandbox.example",
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
}

function createHost(
  overrides: Partial<HostOptions> = {},
  fetchMock: typeof fetch | null = htmlFetch(),
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  if (fetchMock) {
    vi.stubGlobal("fetch", fetchMock);
  }
  const options = hostOptions(frame, overrides);
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  const host = new BoardWidgetSandboxHost(options);
  return { frame, host, options, fetchMock, postMessage };
}

async function readyHost(...args: Parameters<typeof createHost>) {
  const fixture = createHost(...args);
  notifyProxyReady(fixture.host, fixture.frame, fixture.options.sandboxUrl);
  await vi.waitFor(() => expect(fixture.options.onLoaded).toHaveBeenCalledOnce());
  return fixture;
}

function bridgeRequest(
  id: string,
  method = "data.read",
  params: Record<string, unknown> = { bindingId: "health" },
  ticket = "ticket",
) {
  return { type: "openclaw:widget-bridge-request", id, method, params, ticket };
}

function stateRequest(id: string, phase: string, ticket = "ticket") {
  return bridgeRequest(id, "state.emit", { payload: { phase } }, ticket);
}

function promptRequest(id: string, text: string) {
  return bridgeRequest(id, "prompt.send", { text });
}

function sendWindowMessage(
  host: BoardWidgetSandboxHost,
  frame: HTMLIFrameElement,
  data: unknown,
  ports: MessagePort[] = [],
): void {
  host.handleMessage(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://sandbox.example",
      data,
      ports,
    }),
  );
}

function notifyProxyReady(
  host: BoardWidgetSandboxHost,
  frame: HTMLIFrameElement,
  sandboxUrl = SANDBOX_URL,
): void {
  sendWindowMessage(host, frame, {
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl },
  });
}

async function offerBridgePort(
  host: BoardWidgetSandboxHost,
  frame: HTMLIFrameElement,
  onHostMessage?: (event: MessageEvent) => void,
): Promise<MessagePort> {
  const channel = new MessageChannel();
  let initialTicketAdopted = false;
  const initialized = new Promise<void>((resolve) => {
    channel.port2.addEventListener("message", (event) => {
      onHostMessage?.(event);
      if (
        !initialTicketAdopted &&
        event.data?.type === "openclaw:widget-host-init" &&
        typeof event.data.ticket === "string"
      ) {
        initialTicketAdopted = true;
        channel.port2.postMessage(
          { type: "openclaw:widget-host-init-ack", ticket: event.data.ticket },
          [],
        );
        resolve();
      }
    });
  });
  channel.port2.start();
  sendWindowMessage(host, frame, { type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
  await initialized;
  return channel.port2;
}

async function sendBridgeRequest(port: MessagePort, request: Record<string, unknown>) {
  return await new Promise<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "openclaw:widget-bridge-response" || event.data.id !== request.id) {
        return;
      }
      port.removeEventListener("message", listener);
      resolve(event.data as Record<string, unknown>);
    };
    port.addEventListener("message", listener);
    port.postMessage(request, []);
  });
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BoardWidgetSandboxHost", () => {
  it("loads a ticketed document before connecting without accepting bridge requests", async () => {
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const { frame, host, options, fetchMock } = await readyHost({ connected: false, client });
    onTestFinished(() => host.dispose());
    const channel = new MessageChannel();
    onTestFinished(() => channel.port2.close());
    channel.port2.start();
    sendWindowMessage(host, frame, { type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);

    await expect(
      sendBridgeRequest(channel.port2, bridgeRequest("before-hello")),
    ).resolves.toMatchObject({ ok: false, error: "Gateway unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(options.onLoaded).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("fetches ticketed HTML while the proxy starts and delivers it only after readiness", async () => {
    const { frame, host, options, fetchMock, postMessage } = createHost({
      client: { request: vi.fn(async () => ({ ok: true })) },
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      onRendered: vi.fn(),
    });
    const { onLoaded, onRendered } = options;

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(postMessage).not.toHaveBeenCalled();
    expect(onLoaded).not.toHaveBeenCalled();

    notifyProxyReady(host, frame);

    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/__openclaw__/board/weather?bt=ticket",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<!doctype html><p>weather</p>", renderId: expect.any(String) },
      }),
      "https://sandbox.example",
    );
    expect(onRendered).not.toHaveBeenCalled();
    const { renderId } = postMessage.mock.calls[0]![0].params as { renderId: string };
    const rendered = (
      id: string,
      source = frame.contentWindow,
      origin = "https://sandbox.example",
    ) =>
      host.handleMessage(
        new MessageEvent("message", {
          source,
          origin,
          data: { method: "ui/notifications/sandbox-resource-loaded", params: { renderId: id } },
        }),
      );
    rendered("stale-document");
    rendered(renderId, window);
    rendered(renderId, frame.contentWindow, "https://other.example");
    expect(onRendered).not.toHaveBeenCalled();
    rendered(renderId);
    rendered(renderId);
    expect(onRendered).toHaveBeenCalledOnce();
    host.reset();
    rendered(renderId);
    expect(onRendered).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("delivers passive preview HTML without accepting its capability bridge", async () => {
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const { frame, host } = await readyHost({
      client,
      bridgeEnabled: false,
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
    });

    const channel = new MessageChannel();
    const close = vi.spyOn(channel.port1, "close");
    sendWindowMessage(host, frame, { type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);

    expect(close).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("reports transient document fetch failures without confusing them with authorization", async () => {
    const { frame, host, options } = createHost(
      {
        client: { request: vi.fn(async () => ({ ok: true })) },
        resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      },
      htmlFetch("unavailable", { status: 503 }),
    );

    notifyProxyReady(host, frame);

    await vi.waitFor(() => expect(options.onLoadFailed).toHaveBeenCalledWith(widget()));
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("injects the active view ticket only after the current document is loaded", async () => {
    const { frame, host } = await readyHost({
      controlUiBaseUrl: "https://control.example/openclaw",
    });

    const hostMessage = vi.fn();
    await offerBridgePort(host, frame, hostMessage);

    sendWindowMessage(host, frame, { type: "openclaw:widget-bridge-ready" });

    expect(hostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: "openclaw:widget-host-init",
          ticket: "ticket",
          controlUiBaseUrl: "https://control.example/openclaw",
        },
      }),
    );
  });

  it("drops a bridge response after the widget document is replaced", async () => {
    const pending = Promise.withResolvers<unknown>();
    const client = { request: vi.fn(async () => await pending.promise) };
    const { frame, host, options, postMessage } = await readyHost({ client });
    const bridgePort = await offerBridgePort(host, frame);
    const bridgeResponse = vi.fn();
    bridgePort.addEventListener("message", bridgeResponse);
    postMessage.mockClear();

    bridgePort.postMessage(bridgeRequest("old-request"), []);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    host.update({
      ...options,
      widget: { ...widget(), revision: 3, viewTicket: "next-ticket" },
    });
    pending.resolve({ sensitive: "old grant result" });
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeResponse).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      "https://sandbox.example",
    );
  });

  it("accepts bridge requests only on the wrapper-owned private port", async () => {
    const client = {
      request: vi.fn(async (method: string) =>
        method === "board.prompt.authorize" ? { confirmationRequired: false } : { ok: true },
      ),
    };
    const { frame, host } = createHost({ client });
    notifyProxyReady(host, frame);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const request = promptRequest("prompt-request", "Injected");

    sendWindowMessage(host, frame, request);
    await Promise.resolve();
    expect(client.request).not.toHaveBeenCalled();

    const bridgePort = await offerBridgePort(host, frame);
    bridgePort.postMessage(request, []);
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith("board.prompt.authorize", {
        ticket: "ticket",
      }),
    );
  });

  it("scopes prompt rate limits to the board source and view generation", async () => {
    const sessionPrefix = `session-${crypto.randomUUID()}`;
    let activeFrame: HTMLIFrameElement | null = null;
    Object.defineProperty(document, "activeElement", {
      get: () => activeFrame,
      configurable: true,
    });
    const setup = async (sessionId: string, viewGeneration: string) => {
      const { frame, host, options } = createHost({
        widget: { ...widget(), viewGeneration },
        client: {
          request: vi.fn(async (method: string) =>
            method === "board.prompt.authorize" ? { confirmationRequired: false } : { ok: true },
          ),
        },
        resolveFrameUrl: () => `/__openclaw__/board/${sessionId}/weather/index.html?bt=ticket`,
      });
      frame.checkVisibility = () => true;
      notifyProxyReady(host, frame);
      await vi.waitFor(() => expect(options.onLoaded).toHaveBeenCalledOnce());
      return { frame, port: await offerBridgePort(host, frame) };
    };
    const first = await setup(`${sessionPrefix}-a`, "a".repeat(32));
    activeFrame = first.frame;
    for (let index = 0; index < 10; index += 1) {
      await expect(
        sendBridgeRequest(first.port, promptRequest(`first-${index}`, `Prompt ${index}`)),
      ).resolves.toMatchObject({ ok: true });
    }

    const otherSession = await setup(`${sessionPrefix}-b`, "a".repeat(32));
    activeFrame = otherSession.frame;
    await expect(
      sendBridgeRequest(otherSession.port, promptRequest("other-session", "Independent session")),
    ).resolves.toMatchObject({ ok: true });

    const recreated = await setup(`${sessionPrefix}-a`, "b".repeat(32));
    activeFrame = recreated.frame;
    await expect(
      sendBridgeRequest(recreated.port, promptRequest("recreated-view", "Independent generation")),
    ).resolves.toMatchObject({ ok: true });
    delete (document as unknown as Record<string, unknown>).activeElement;
  });

  it("keeps the adopted ticket valid until the wrapper acknowledges a renewal", async () => {
    const pending = Promise.withResolvers<unknown>();
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "board.data.read") {
          return await pending.promise;
        }
        return { ok: true };
      }),
    };
    const { frame, host, options } = await readyHost({
      client,
      resolveFrameUrl: () => "/widget?bt=ticket",
    });
    const bridgePort = await offerBridgePort(host, frame);
    const responses: unknown[] = [];
    let renewalTicket = "";
    bridgePort.addEventListener("message", (event) => {
      if (event.data?.type === "openclaw:widget-host-init") {
        renewalTicket = event.data.ticket;
      } else if (event.data?.type === "openclaw:widget-bridge-response") {
        responses.push(event.data);
      }
    });

    bridgePort.postMessage(bridgeRequest("in-flight"), []);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    host.update({
      ...options,
      widget: { ...widget(), viewTicket: "renewed-ticket" },
      resolveFrameUrl: () => "/widget?bt=renewed-ticket",
    });
    bridgePort.postMessage(stateRequest("before-ack", "renewing"), []);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renewalTicket).toBe("renewed-ticket"));

    bridgePort.postMessage({ type: "openclaw:widget-host-init-ack", ticket: renewalTicket }, []);
    pending.resolve({ status: "healthy" });
    await vi.waitFor(() =>
      expect(responses).toContainEqual(expect.objectContaining({ id: "in-flight", ok: true })),
    );
    bridgePort.postMessage(stateRequest("after-ack", "renewed", "renewed-ticket"), []);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
    expect(client.request).toHaveBeenNthCalledWith(2, "board.event", {
      ticket: "ticket",
      payload: { phase: "renewing" },
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "board.event", {
      ticket: "renewed-ticket",
      payload: { phase: "renewed" },
    });
  });

  it.each(["replaced", "reconnected"])(
    "cancels in-flight requests when the Gateway client is %s",
    async (change) => {
      const pending = Promise.withResolvers<unknown>();
      const oldClient = { request: vi.fn(async () => await pending.promise) };
      const newClient =
        change === "reconnected" ? oldClient : { request: vi.fn(async () => ({ ok: true })) };
      const { frame, host, options } = await readyHost({
        client: oldClient,
        resolveFrameUrl: () => "/widget?bt=ticket",
      });
      const bridgePort = await offerBridgePort(host, frame);
      const responses: unknown[] = [];
      bridgePort.addEventListener("message", (event) => {
        if (event.data?.type === "openclaw:widget-bridge-response") {
          responses.push(event.data);
        }
      });

      bridgePort.postMessage(bridgeRequest("old-client"), []);
      await vi.waitFor(() => expect(oldClient.request).toHaveBeenCalledOnce());
      if (change === "reconnected") {
        host.update({ ...options, connected: false, documentActive: false });
      }
      host.update({ ...options, client: newClient, connected: true });
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
      newClient.request.mockClear();
      newClient.request.mockResolvedValue({ ok: true });

      await expect(
        sendBridgeRequest(bridgePort, stateRequest("new-client", "reconnected")),
      ).resolves.toMatchObject({ id: "new-client", ok: false });
      expect(newClient.request).not.toHaveBeenCalled();
      const renewal = new Promise<void>((resolve) => {
        bridgePort.addEventListener("message", (event) => {
          if (
            event.data?.type === "openclaw:widget-host-init" &&
            event.data.ticket === "renewed-ticket"
          ) {
            bridgePort.postMessage(
              { type: "openclaw:widget-host-init-ack", ticket: "renewed-ticket" },
              [],
            );
            resolve();
          }
        });
      });
      host.update({
        ...options,
        client: newClient,
        widget: { ...widget(), viewTicket: "renewed-ticket" },
      });
      await renewal;
      await expect(
        sendBridgeRequest(bridgePort, stateRequest("revalidated", "reconnected", "renewed-ticket")),
      ).resolves.toMatchObject({ id: "revalidated", ok: true });
      expect(newClient.request).toHaveBeenCalledWith("board.event", {
        ticket: "renewed-ticket",
        payload: { phase: "reconnected" },
      });
    },
  );

  it("reloads equal-name revisions when their board session identity changes", async () => {
    const { host, options, fetchMock, postMessage } = await readyHost({
      client: { request: vi.fn(async () => ({ ok: true })) },
      resolveFrameUrl: () => "/__openclaw__/board/session-a/weather/index.html?bt=one",
    });
    postMessage.mockClear();

    host.update({
      ...options,
      widget: { ...widget(), viewTicket: "next-ticket" },
      resolveFrameUrl: () => "/__openclaw__/board/session-b/weather/index.html?bt=two",
    });

    expect(postMessage).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      "https://sandbox.example",
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("waits for the exact sandbox CSP navigation before delivering replacement HTML", async () => {
    const wideSandboxUrl = `${SANDBOX_URL}?csp=wide`;
    const narrowSandboxUrl = `${SANDBOX_URL}?csp=narrow`;
    const { frame, host, options, fetchMock, postMessage } = await readyHost({
      sandboxUrl: wideSandboxUrl,
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=ticket",
    });
    const ready = (sandboxUrl: string) => notifyProxyReady(host, frame, sandboxUrl);

    postMessage.mockClear();
    host.update({
      ...options,
      sandboxUrl: narrowSandboxUrl,
      widget: {
        ...widget(),
        revision: 3,
        viewTicket: "replacement-ticket",
        viewGeneration: "b".repeat(32),
      },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=replacement-ticket",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postMessage).not.toHaveBeenCalled();
    ready(wideSandboxUrl);
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();

    ready(narrowSandboxUrl);
    await vi.waitFor(() => expect(options.onLoaded).toHaveBeenCalledTimes(2));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/sandbox-resource-ready" }),
      "https://sandbox.example",
    );
    host.dispose();
  });

  it("reloads a deleted and recreated widget without reloading routine ticket renewals", async () => {
    const sourceUrl = "https://gateway.example/__openclaw__/board/session/weather/index.html";
    const originalFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = htmlFetch();
    const { frame, host, options } = createHost(
      { resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=ticket" },
      (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        // Other resources can load in the shared worker while this widget settles.
        return url.split(/[?#]/u, 1)[0] === sourceUrl
          ? fetchMock(input, init)
          : originalFetch(input, init);
      },
    );
    onTestFinished(() => host.dispose());
    notifyProxyReady(host, frame);
    await vi.waitFor(() => expect(options.onLoaded).toHaveBeenCalledOnce());

    host.update({
      ...options,
      widget: { ...widget(), viewTicket: "renewed-ticket" },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=renewed-ticket",
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    host.update({
      ...options,
      widget: {
        ...widget(),
        viewTicket: "replacement-ticket",
        viewGeneration: "b".repeat(32),
      },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=replacement-ticket",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("records one-shot proxy readiness while inactive", async () => {
    vi.useFakeTimers();
    const { frame, host, options, fetchMock } = createHost();
    const { onReadyTimeout, onLoaded } = options;
    const reloadFrame = vi.spyOn(frame, "src", "set");

    host.setActive(false);
    notifyProxyReady(host, frame);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReadyTimeout).not.toHaveBeenCalled();

    host.setActive(true);
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reloadFrame).not.toHaveBeenCalled();
    host.dispose();
  });

  it("retains a ready loaded frame and bridge while inactive", async () => {
    vi.useFakeTimers();
    const client = { request: vi.fn(async () => ({ resumed: true })) };
    const { frame, host, options, fetchMock } = await readyHost({ client });
    const { onReadyTimeout } = options;
    const bridgePort = await offerBridgePort(host, frame);
    const retainedFrame = host.frame;
    const reloadFrame = vi.spyOn(frame, "src", "set");

    host.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(sendBridgeRequest(bridgePort, bridgeRequest("inactive"))).resolves.toMatchObject({
      ok: false,
      error: "Widget inactive",
    });
    expect(client.request).not.toHaveBeenCalled();

    host.setActive(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.frame).toBe(retainedFrame);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onReadyTimeout).not.toHaveBeenCalled();
    expect(reloadFrame).not.toHaveBeenCalled();
    await expect(sendBridgeRequest(bridgePort, bridgeRequest("resumed"))).resolves.toMatchObject({
      ok: true,
      result: { resumed: true },
    });
    bridgePort.close();
    host.dispose();
  });

  it("resumes one interrupted document load after reactivation", async () => {
    const pending = Promise.withResolvers<Response>();
    const sourceUrl = "https://gateway.example/widget";
    const originalFetch = globalThis.fetch.bind(globalThis);
    let sourceFetches = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== sourceUrl) {
        return await originalFetch(input, init);
      }
      sourceFetches += 1;
      if (sourceFetches === 1) {
        return await pending.promise;
      }
      return new Response("<!doctype html><p>resumed</p>");
    });
    const { frame, host, options } = createHost({}, fetchMock);
    const { onLoaded } = options;
    notifyProxyReady(host, frame);
    await vi.waitFor(() => expect(sourceFetches).toBe(1));

    host.setActive(false);
    pending.resolve(new Response("<!doctype html><p>stale</p>"));
    await Promise.resolve();
    expect(onLoaded).not.toHaveBeenCalled();

    host.setActive(true);
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    expect(sourceFetches).toBe(2);
    host.dispose();
  });

  it("bounds missing proxy readiness and stops the timer on disposal", async () => {
    vi.useFakeTimers();
    // Document failures share the retry backoff; keep only the proxy unavailable.
    const { frame, host, options, fetchMock } = createHost();
    const { onReadyTimeout, onLoadFailed } = options;

    host.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onReadyTimeout).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    host.setActive(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onReadyTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onReadyTimeout).toHaveBeenCalledOnce();
    expect(frame.src).toBe("");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frame.src).toBe(SANDBOX_URL);
    const reloadSpy = vi.spyOn(frame, "src", "set");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloadSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reloadSpy).toHaveBeenCalledWith(SANDBOX_URL);
    expect(onReadyTimeout).toHaveBeenCalledTimes(2);
    host.dispose();
    // Cross both the canceled readiness deadline and its next retry window.
    await vi.advanceTimersByTimeAsync(34_000);
    expect(onReadyTimeout).toHaveBeenCalledTimes(2);
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(onLoadFailed).not.toHaveBeenCalled();
  });

  it("rejects Gateway widget HTML that advertises more than the protocol byte cap", async () => {
    const socketClosed = Promise.withResolvers<void>();
    let requestCount = 0;
    const advertised = WIDGET_HTML_MAX_UTF8_BYTES + 1;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.socket.once("close", () => socketClosed.resolve());
      // Advertise oversize Content-Length and leave the body open so cancel is
      // visible as a closed TCP socket instead of a full download.
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(advertised),
      });
      response.write("<!doctype html><p>partial</p>");
    });
    const origin = await listenOnLoopback(server);
    const rejected = Promise.withResolvers<void>();
    const onError = vi.fn<(error: unknown) => void>(() => rejected.resolve());
    const { frame, host, options } = createHost({ onError, sourceOrigin: origin }, null);
    notifyProxyReady(host, frame);
    try {
      await rejected.promise;
      expect(onError).toHaveBeenCalledOnce();
      expect(options.onLoaded).not.toHaveBeenCalled();
      expect(options.onLoadFailed).not.toHaveBeenCalled();
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        message: "widget HTML exceeds 10 MiB; regenerate a smaller widget",
      });
      expect(requestCount).toBe(1);
      await socketClosed.promise;
    } finally {
      host.dispose();
      await closeServer(server);
    }
  });
});
