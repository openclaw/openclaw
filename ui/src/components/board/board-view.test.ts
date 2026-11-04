import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "../../lib/board/grid.ts";
import "../../lib/toast-host.tsx";
import "../mcp-app-view.tsx";
// Side-effect import: registers the custom elements mount() depends on
// without relying on transitive fixture imports.
import "./board-view.tsx";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  expectText,
  mountWidget,
  widgetSnapshot,
  testId,
  boardWidget,
  callbacks,
  gatewayContext,
  mount,
  openBoardMenu,
  settleCells,
  snapshot,
} from "./board-view.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function frameMessage(frame: HTMLIFrameElement, data: object, ports: MessagePort[] = []) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: new URL(frame.src).origin,
      data,
      ports,
    }),
  );
}
function keyDown(target: EventTarget | undefined, key: string, altKey = false) {
  target?.dispatchEvent(
    new KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true }),
  );
}

const cellsOf = (root: ParentNode) => [...root.querySelectorAll("openclaw-board-widget-cell")];
const removeButton = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".board-widget__menu-danger");
const grantButton = (root: ParentNode, decision: "allow" | "reject") =>
  root.querySelector<HTMLButtonElement>(`[data-test-id="board-grant-${decision}"]`);
const sandboxSnapshot = (widget: Parameters<typeof widgetSnapshot>[0] = {}) =>
  widgetSnapshot({
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 18790,
    viewTicket: "ticket",
    ...widget,
  });
const documentUrl = () => "/__openclaw__/board/session/alpha/index.html?bt=ticket";

function pointer(
  target: EventTarget,
  type: string,
  clientY: number,
  clientX = 100,
  cancelable = false,
) {
  const event = new MouseEvent(type, {
    button: 0,
    clientX,
    clientY,
    bubbles: true,
    cancelable,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  target.dispatchEvent(event);
}

function stubBoardDocumentFetch(read: () => Promise<Response>): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.includes("/__openclaw__/board/") ? read() : originalFetch(input, init);
  }) satisfies typeof fetch);
}

describe("openclaw-board-view", () => {
  it("retains one loading surface through snapshot and sandbox document readiness", async () => {
    vi.useFakeTimers();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    stubBoardDocumentFetch(fetchMock);
    const view = document.createElement("openclaw-board-view");
    view.activeTabId = "main";
    view.callbacks = callbacks();
    view.widgetFrameUrl = documentUrl;
    const provider = createApplicationContextProvider(gatewayContext(null));
    provider.append(view);
    document.body.append(provider);
    await view.updateComplete;
    const skeleton = view.querySelector("openclaw-panel-loading-skeleton");
    expect(skeleton).not.toBeNull();
    view.snapshot = sandboxSnapshot();
    await settleCells(view);
    const frame = view.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(frame.getAttribute("loading")).toBe("eager");
    const ready = deferred<{ renderId: string }>();
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
      if (message.method === "ui/notifications/sandbox-resource-ready") {
        ready.resolve(message.params);
      }
    });
    const receive = (data: object) => frameMessage(frame, data);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(view.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
    expect(view.querySelector("openclaw-panel-loading-skeleton")).toBe(skeleton);
    expect(view.querySelector(".board-view")?.hasAttribute("inert")).toBe(true);
    receive({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } });
    response.resolve(new Response("<p>Dashboard</p>"));
    const { renderId } = await ready.promise;
    await settleCells(view);
    expect(view.querySelector("openclaw-panel-loading-skeleton")).toBe(skeleton);
    receive({ method: "ui/notifications/sandbox-resource-loaded", params: { renderId } });
    await vi.advanceTimersByTimeAsync(32);
    await settleCells(view);
    expect(view.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(view.querySelector(".board-view")?.hasAttribute("inert")).toBe(false);
    expect(view.querySelector("iframe")).toBe(frame);
  });

  it("paces a stalled proxy retry without spending the authorization refresh budget", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>Ready document</p>"));
    stubBoardDocumentFetch(fetchMock);
    const frameLoadFailed = vi.fn(async () => undefined);
    const view = await mount({
      context: gatewayContext(null),
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: sandboxSnapshot(),
      widgetFrameUrl: documentUrl,
    });
    const frame = view.querySelector("iframe")!;
    const source = frame.src;
    // Browser navigation keeps the WindowProxy; jsdom replaces it when src is assigned.
    const reload = vi.spyOn(frame, "src", "set").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await settleCells(view);
    expect(view.querySelector('.board-widget__notice[role="status"]')).not.toBeNull();
    expect(testId(view, "board-widget-error")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledExactlyOnceWith(source);
    expect(frameLoadFailed).not.toHaveBeenCalled();
    expect(view.querySelector("iframe")).toBe(frame);
    frameMessage(frame, {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: source },
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleCells(view);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.querySelector('.board-widget__notice[role="status"]')).toBeNull();
    expect(testId(view, "board-widget-error")).toBeNull();
  });

  it("requires a renewed frame ticket before using a reconnected Gateway client", async () => {
    const firstRequest = vi.fn(async () => ({ ok: true }));
    const secondRequest = vi.fn(async () => ({ ok: true }));
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>weather</p>"));
    stubBoardDocumentFetch(fetchMock);
    let ticket = "ticket";
    const widget = () =>
      boardWidget({
        sandboxUrl: "/mcp-app-sandbox",
        sandboxPort: 18790,
        viewTicket: ticket,
        viewGeneration: "retained-document",
      });
    const context = gatewayContext({ request: firstRequest }, "/control");
    const connection = createApplicationGateway(context.gateway.snapshot);
    connection.gateway.connection.gatewayUrl = context.gateway.connection.gatewayUrl;
    const view = await mount({
      context: { ...context, gateway: connection.gateway },
      snapshot: snapshot({ widgets: [widget()] }),
      widgetFrameUrl: () => "/__openclaw__/board/session/alpha/index.html?bt=" + ticket,
    });
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const frame = cell.querySelector("iframe")!;
    const send = (data: object, ports: MessagePort[] = []) => frameMessage(frame, data, ports);
    send({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const bridgeChannel = new MessageChannel();
    onTestFinished(() => bridgeChannel.port2.close());
    const initialized = deferred<{ controlUiBaseUrl?: string }>();
    const renewed = deferred();
    bridgeChannel.port2.addEventListener("message", (event) => {
      if (event.data?.type !== "openclaw:widget-host-init") {
        return;
      }
      bridgeChannel.port2.postMessage(
        { type: "openclaw:widget-host-init-ack", ticket: event.data.ticket },
        [],
      );
      initialized.resolve(event.data);
      if (event.data.ticket === "renewed-ticket") {
        renewed.resolve();
      }
    });
    bridgeChannel.port2.start();
    send({ type: "openclaw:widget-bridge-port-offer" }, [bridgeChannel.port1]);
    expect((await initialized.promise).controlUiBaseUrl).toBe(window.location.origin + "/control");
    const emit = (id: string, requestTicket: string, status: string) =>
      new Promise<unknown>((resolve) => {
        const receive = (event: MessageEvent) => {
          if (event.data?.type === "openclaw:widget-bridge-response" && event.data.id === id) {
            bridgeChannel.port2.removeEventListener("message", receive);
            resolve(event.data);
          }
        };
        bridgeChannel.port2.addEventListener("message", receive);
        bridgeChannel.port2.postMessage(
          {
            type: "openclaw:widget-bridge-request",
            id,
            method: "state.emit",
            params: { payload: { status } },
            ticket: requestTicket,
          },
          [],
        );
      });
    await expect(emit("before-reconnect", ticket, "connecting")).resolves.toMatchObject({
      ok: true,
    });
    expect(firstRequest).toHaveBeenCalledExactlyOnceWith("board.event", {
      ticket,
      payload: { status: "connecting" },
    });
    connection.publish({
      ...connection.gateway.snapshot,
      client: gatewayContext({ request: secondRequest }).gateway.snapshot.client,
    });
    await settleCells(view);
    await expect(emit("retired-ticket", ticket, "online")).resolves.toMatchObject({
      ok: false,
      error: "Gateway unavailable",
    });
    expect(secondRequest).not.toHaveBeenCalled();
    ticket = "renewed-ticket";
    view.snapshot = snapshot({ widgets: [widget()] });
    await settleCells(view);
    await renewed.promise;
    await expect(emit("after-reconnect", ticket, "online")).resolves.toMatchObject({ ok: true });
    expect(secondRequest).toHaveBeenCalledExactlyOnceWith("board.event", {
      ticket,
      payload: { status: "online" },
    });
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(view.querySelector("iframe")).toBe(frame);
  });
  it("requests a fresh frame ticket after iframe errors or 401 loads", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response("expired", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: widgetSnapshot(),
      widgetFrameUrl: () => "/__openclaw__/board/session/status/index.html?bt=expired",
    });
    const frame = view.querySelector("iframe");

    frame?.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(1));
    frame?.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/__openclaw__/board/session/status/index.html?bt=expired",
      { cache: "no-store" },
    );
  });

  it("keeps retrying proactive ticket refresh after the initial outage", async () => {
    vi.useFakeTimers();
    stubBoardDocumentFetch(async () => new Response("<p>Current widget</p>"));
    const frameLoadFailed = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockResolvedValue(undefined);
    const view = await mount({
      context: gatewayContext(null),
      widgetFrameUrl: documentUrl,
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: sandboxSnapshot({ viewTicketTtlMs: 15_000 }),
    });
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const frame = cell.querySelector("iframe");
    expect(frame).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(frameLoadFailed).toHaveBeenCalledTimes(5);
    await settleCells(view);
    expect(cell.querySelector("iframe")).toBe(frame);
    expect(testId(cell, "board-widget-error")).toBeNull();
  });

  it("bounds repeated frame ticket refreshes after persistent 401 responses", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    let frameStatus = 401;
    let frameUrl = "/__openclaw__/board/session/status/index.html?bt=expired";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(frameStatus === 401 ? "expired" : "ok", { status: frameStatus }),
      ),
    );
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: widgetSnapshot(),
      widgetFrameUrl: () => frameUrl,
    });
    const frame = view.querySelector("iframe");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      frame?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    }

    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expectText(testId(view, "board-widget-error"), "repeated refresh attempts"),
    );

    frameStatus = 200;
    frameUrl = "/__openclaw__/board/session/status/index.html?bt=fresh";
    view.snapshot = snapshot({ revision: 2, widgets: [boardWidget()] });
    await settleCells(view);
    const freshFrame = view.querySelector("iframe");
    expect(freshFrame?.getAttribute("src")).toBe(frameUrl);
    freshFrame?.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(view.querySelector("iframe")).toBe(freshFrame));
    expect(frameLoadFailed).toHaveBeenCalledTimes(3);
  });

  it("ignores authorization results from a superseded widget frame", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    const probe = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => probe.promise),
    );
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: widgetSnapshot(),
      widgetFrameUrl: (_name, revision) =>
        `/__openclaw__/board/session/status/index.html?revision=${revision}`,
    });
    const frame = view.querySelector("iframe");
    frame?.dispatchEvent(new Event("load"));

    view.snapshot = snapshot({
      revision: 2,
      widgets: [boardWidget({ revision: 2 })],
    });
    await settleCells(view);
    expect(frame?.getAttribute("src")).toContain("revision=2");
    probe.resolve(new Response("expired", { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(frameLoadFailed).not.toHaveBeenCalled();
  });

  it("shows failed host operations in the board and originating cell", async () => {
    const applyOps = vi.fn(async () => {
      throw new Error("fixture write failed");
    });
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const frame = view.querySelector("iframe");
    await openBoardMenu(view);
    view.querySelector<HTMLButtonElement>(".board-widget__menu-danger")?.click();
    await vi.waitFor(() => {
      expectText(view.querySelector(".board-view__error"), "could not be saved");
      expectText(testId(view, "board-widget-action-error"), "fixture write failed");
    });
    expect(view.querySelector("iframe")).toBe(frame);
    view.snapshot = { ...snapshot(), revision: 2 };
    await settleCells(view);
    expect(view.querySelector(".board-view__error")).toBeNull();
  });

  it("allows only one snapshot-derived board mutation at a time", async () => {
    const pending = deferred();
    const applyOps = vi.fn(() => pending.promise);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const cells = cellsOf(view);
    await openBoardMenu(cells[0]!);
    removeButton(cells[0]!)?.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    await settleCells(view);
    await openBoardMenu(cells[1]!);
    const secondRemove = removeButton(cells[1]!);
    expect(secondRemove?.disabled).toBe(true);
    secondRemove?.click();
    expect(applyOps).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.waitFor(() => expect(secondRemove?.disabled).toBe(false));
  });

  it("clears a failed mutation during retry without replacing the widget document", async () => {
    const pending = deferred();
    const applyOps = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture write failed"))
      .mockImplementationOnce(() => pending.promise);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const frame = view.querySelector("iframe");
    await openBoardMenu(view);
    removeButton(view)?.click();
    await vi.waitFor(() =>
      expectText(view.querySelector(".board-view__error"), "could not be saved"),
    );

    await openBoardMenu(view);
    const remove = removeButton(view);
    remove?.click();
    await vi.waitFor(() => {
      expect(applyOps).toHaveBeenCalledTimes(2);
      expect(view.querySelector(".board-view__error")).toBeNull();
      expect(remove?.disabled).toBe(true);
    });
    expect(view.querySelector("iframe")).toBe(frame);

    pending.resolve();
    await vi.waitFor(() => {
      expect(remove?.disabled).toBe(false);
      expectText(view.querySelector(".board-announcer"), "Removed Alpha status");
    });
    expect(view.querySelector(".board-view__error")).toBeNull();
    expect(view.querySelector("iframe")).toBe(frame);
  });

  it("ignores a late operation failure after switching sessions", async () => {
    const pending = deferred();
    const applyOps = vi.fn(() => pending.promise);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    await openBoardMenu(view);
    removeButton(view)?.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    view.snapshot = { ...snapshot(), sessionKey: "agent:main:new-session" };
    await settleCells(view);
    pending.reject(new Error("old session failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.querySelector(".board-view__error")).toBeNull();
    expect(view.querySelector(".board-announcer")?.textContent?.trim()).toBe("");
  });

  it.each([
    { profile: "read-only", canMutate: false, canGrant: false, controls: false },
    { profile: "writer with approvals", canMutate: true, canGrant: true, controls: true },
  ])("gates dashboard controls for the $profile scope profile", async (profile) => {
    const view = await mount({
      snapshot: widgetSnapshot({ grantState: "pending" }),
      canMutate: profile.canMutate,
      canGrant: profile.canGrant,
    });

    expect(view.querySelector(".board-widget__drag-handle") !== null).toBe(profile.controls);
    expect(view.querySelector(".board-widget__resize-handle") !== null).toBe(profile.controls);
    expect(view.querySelector(".board-widget__menu") !== null).toBe(profile.controls);
    expect(grantButton(view, "allow")?.disabled).toBe(!profile.canGrant);
    expect(grantButton(view, "reject")?.disabled).toBe(!profile.canGrant);
  });

  it("does not schedule renewal when an in-flight MCP App load resolves after disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pending = deferred<{
      status: "ready";
      viewId: string;
      expiresAtMs: number;
    }>();
    const widgetAppView = vi.fn(() => pending.promise);
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-renewed",
      expiresAtMs: 71_000,
    }));
    const view = await mount({
      snapshot: widgetSnapshot({ contentKind: "mcp-app" }),
      callbacks: callbacks({ widgetAppView, refreshWidgetAppView }),
    });
    expect(widgetAppView).toHaveBeenCalledWith("alpha", 1);

    view.remove();
    pending.resolve({ status: "ready", viewId: "late-view", expiresAtMs: 11_000 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refreshWidgetAppView).not.toHaveBeenCalled();
  });

  it("shows stale MCP Apps with retry and delete without breaking the board", async () => {
    const widgetAppView = vi.fn(async () => ({
      status: "stale" as const,
    }));
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-retried",
      expiresAtMs: Date.now() + 60_000,
    }));
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({
      snapshot: widgetSnapshot({ contentKind: "mcp-app" }),
      callbacks: callbacks({ applyOps, widgetAppView, refreshWidgetAppView }),
      context: gatewayContext(null),
    });

    await vi.waitFor(() => expect(testId(view, "board-mcp-app-stale")).not.toBeNull());
    const buttons = view.querySelectorAll<HTMLButtonElement>(
      '[data-test-id="board-mcp-app-stale"] button',
    );
    expect([...buttons].map((button) => button.textContent?.trim())).toEqual(["Retry", "Delete"]);
    buttons[1]?.click();
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "alpha" }]),
    );
    buttons[0]?.click();
    await vi.waitFor(() =>
      expect(view.querySelector<HTMLElement & { viewId: string }>("mcp-app-view")?.viewId).toBe(
        "mcp-app-retried",
      ),
    );
    expect(view.querySelector("mcp-app-view .mount")).not.toBeNull();
    expect(refreshWidgetAppView).toHaveBeenCalledWith("alpha", 1);
  });

  it("renders declared approval details instead of the generic copy", async () => {
    const view = await mountWidget({
      grantState: "pending",
      declaredSummary: ["Network access: https://api.example.com", "Tool access: lookup"],
      declared: { netOrigins: ["https://api.example.com"], tools: ["lookup"] },
    });
    const pending = testId(view, "board-pending");

    expect(pending?.querySelectorAll(".board-widget__grant-summary li")).toHaveLength(2);
    expectText(pending, "Network origins", "https://api.example.com", "Host tools and data");
    expect(pending?.textContent).not.toContain("This widget requested additional access.");
  });

  it("shows granted capabilities in a compact chip and tooltip", async () => {
    const view = await mountWidget({
      grantState: "granted",
      declared: { netOrigins: ["https://api.example.com"], tools: ["health"] },
    });
    const chip = testId(view, "board-capabilities-granted");
    const tooltip = chip?.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string })
      | null;

    expect(chip?.textContent?.trim()).toBe("Granted");
    expect(tooltip?.content).toContain("Network: https://api.example.com");
    expect(tooltip?.content).toContain("Tool: health");
  });

  it("serializes pending approval decisions while the callback is in flight", async () => {
    const pending = deferred();
    const grant = vi.fn(() => pending.promise);
    const view = await mount({
      snapshot: widgetSnapshot({ grantState: "pending" }),
      callbacks: callbacks({ grant }),
    });
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    const reject = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-reject"]');
    expect(view.querySelector("iframe")).toBeNull();
    allow?.click();
    reject?.click();
    expect(grant).toHaveBeenCalledTimes(1);
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    expect([allow?.disabled, reject?.disabled]).toEqual([true, true]);
    pending.resolve();
    await vi.waitFor(() => expect(allow?.disabled).toBe(false));
  });

  it("toasts failed rejection while keeping controls and leaves successful decisions quiet", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const grant = vi.fn(async (_name: string, decision: "granted" | "rejected") => {
      if (decision === "rejected") {
        throw new Error("approval service unavailable");
      }
    });
    const source = widgetSnapshot({ grantState: "pending" });
    const view = await mount({ snapshot: source, callbacks: callbacks({ grant }) });
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    const reject = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-reject"]');
    allow?.click();
    await vi.waitFor(() => expect(grant).toHaveBeenCalledWith("alpha", "granted"));
    await vi.waitFor(() => expect(reject?.disabled).toBe(false));
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    reject?.click();
    await vi.waitFor(() => {
      expectText(testId(view, "board-widget-action-error"), "approval service unavailable");
      expectText(
        toastHost.querySelector(".app-toast__message"),
        "Could not reject widget access. Try again.",
      );
    });
    expect([allow?.disabled, reject?.disabled]).toEqual([false, false]);

    view.snapshot = structuredClone({ ...source, revision: source.revision + 1 });
    await settleCells(view);
    expect(testId(view, "board-widget-action-error")).toBeNull();
  });

  it("keeps a rejected widget inert and removable", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({
      snapshot: widgetSnapshot({ grantState: "rejected" }),
      callbacks: callbacks({ applyOps }),
    });
    expect(testId(view, "board-rejected")).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    view.querySelector<HTMLButtonElement>('[data-test-id="board-rejected"] button')?.click();
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "alpha" }]),
    );
  });

  it("does not downgrade snapshots that advertise the shared sandbox contract", async () => {
    const view = await mount({
      snapshot: widgetSnapshot({ viewTicket: "ticket" }),
    });

    expect(view.querySelector("iframe")).toBeNull();
    expectText(testId(view, "board-widget-error"), "Widget sandbox host is unavailable.");
  });

  it("keeps cell focus order stable and exposes move, resize, and menu labels", async () => {
    const view = await mount();
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    expect(cells.map((cell) => cell.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    expect(cells.map((cell) => cell.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
    expect(cells.map((cell) => cell.getAttribute("data-widget-name"))).toEqual(["alpha", "beta"]);
    for (const cell of cells) {
      const frame = cell.querySelector("iframe");
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(cell.getAttribute("aria-label")).toContain("Dashboard widget");
      const drag = cell.querySelector(".board-widget__drag-handle");
      const resize = cell.querySelector(".board-widget__resize-handle");
      const menu = cell.querySelector(".board-widget__menu-trigger");
      expect(drag?.getAttribute("title")).toMatch(/^Move /u);
      expect(resize?.getAttribute("title")).toMatch(/^Resize /u);
      expect([drag?.getAttribute("tabindex"), resize?.getAttribute("tabindex")]).toEqual([
        null,
        null,
      ]);
      expect(menu?.getAttribute("aria-label")).toBe("Widget options");
    }

    cells[0]?.focus();
    keyDown(cells[0], "ArrowRight");
    await vi.waitFor(() => expect(document.activeElement).toBe(cells[1]));
    await vi.waitFor(() => expect(cells[1]?.getAttribute("tabindex")).toBe("0"));
  });

  it("uses Alt+Arrow as the keyboard reorder fallback and announces the move", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const secondCell = view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')[1];
    keyDown(secondCell, "ArrowLeft", true);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "beta", position: 0 }]),
    );
    await vi.waitFor(() => expectText(view.querySelector(".board-announcer"), "Moved Beta chart"));
  });

  it("leaves arrow keys from nested widget controls untouched", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const menuButton = view.querySelector<HTMLButtonElement>(".board-widget__menu-trigger");
    menuButton?.focus();
    keyDown(menuButton ?? undefined, "ArrowRight", true);
    await Promise.resolve();
    expect(document.activeElement).toBe(menuButton);
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("settles a same-turn resize from the pointer-up position", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle")!;
    pointer(handle, "pointerdown", 100);
    pointer(window, "pointerup", 100 + 2 * (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP));
    expect(applyOps).toHaveBeenCalledExactlyOnceWith([
      { kind: "widget_resize", name: "alpha", sizeW: 6, sizeH: 6, heightMode: "fixed" },
    ]);
    await settleCells(view);
    expect(view.querySelector(".board-widget--dragging")).toBeNull();
    expectText(view.querySelector(".board-announcer"), "Resized Alpha status");
  });

  it("cancels an in-progress gesture when the board becomes inactive", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    pointer(handle!, "pointerdown", 100, 100, true);
    await view.updateComplete;
    expect(view.querySelector(".board-widget--dragging")).not.toBeNull();

    view.active = false;
    await settleCells(view);
    expect(view.querySelector(".board-widget--dragging")).toBeNull();

    pointer(window, "pointerup", 200, 200);
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("places excess tabs in an accessible overflow menu", async () => {
    const source = snapshot({
      tabs: Array.from({ length: 8 }, (_entry, position) => ({
        tabId: `tab-${position}`,
        title: `Tab ${position}`,
        position,
        chatDock: "right" as const,
      })),
      widgets: [],
    });
    const selectTab = vi.fn();
    const view = await mount({
      snapshot: source,
      activeTabId: "tab-7",
      callbacks: callbacks({ selectTab }),
    });
    expect(view.querySelector(".board-tabs__overflow-trigger")?.getAttribute("aria-label")).toBe(
      "More dashboard tabs",
    );
    await openBoardMenu(view, ".board-tabs__overflow-trigger");
    expect(view.querySelectorAll(".board-tabs__overflow-item")).toHaveLength(2);
    const firstOverflowTab = view.querySelector<HTMLButtonElement>(".board-tabs__overflow-item")!;
    firstOverflowTab.click();
    await vi.waitFor(() => expect(selectTab).toHaveBeenCalledWith(firstOverflowTab.dataset.value));
  });
});
