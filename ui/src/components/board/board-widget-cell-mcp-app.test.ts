import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { boardWidget } from "./board-view.test-support.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

const disposers: Array<() => void> = [];
function mountElement(element: HTMLElement): void {
  disposers.push(mountSolid(() => element, { container: document.body }).unmount);
}

class TestMcpAppView extends HTMLElement {
  sessionKey = "";
  viewId = "";
  fillContainer = false;
  override title = "";
  teardown = vi.fn(async () => {});
  restartAfterTeardown = vi.fn();
}

if (!customElements.get("mcp-app-view")) {
  customElements.define("mcp-app-view", TestMcpAppView);
}

type BoardWidgetCell = HTMLElementTagNameMap["openclaw-board-widget-cell"];

function widget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return boardWidget({
    title: "Alpha app",
    contentKind: "mcp-app",
    instanceId: "alpha-instance",
    ...overrides,
  });
}

function readyAppView(viewId: string, expiresAtMs = Date.now() + 60_000) {
  return { status: "ready" as const, viewId, expiresAtMs };
}

function callbacks(overrides: Partial<BoardWidgetCellCallbacks> = {}): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    appViewGeneration: () => 0,
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    setHeightMode: noAction,
    reportContentHeight: vi.fn(),
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => readyAppView("initial-view")),
    refreshWidgetAppView: vi.fn(async () => readyAppView("renewed-view")),
    ...overrides,
  };
}

async function mount(
  currentWidget: BoardWidget = widget(),
  currentCallbacks: BoardWidgetCellCallbacks = callbacks(),
  active = true,
): Promise<BoardWidgetCell> {
  const cell = document.createElement("openclaw-board-widget-cell");
  cell.widget = currentWidget;
  cell.rect = { name: currentWidget.name, x: 0, y: 0, w: 6, h: currentWidget.sizeH };
  cell.sessionKey = "agent:main:test";
  cell.callbacks = currentCallbacks;
  cell.active = active;
  mountElement(cell);
  await settle(cell);
  return cell;
}

async function settle(cell: BoardWidgetCell): Promise<void> {
  await Promise.resolve();
  await cell.updateComplete;
  await Promise.resolve();
  await cell.updateComplete;
}

const app = (cell: BoardWidgetCell) => cell.querySelector<TestMcpAppView>("mcp-app-view");
const stale = (cell: BoardWidgetCell) => cell.querySelector('[data-test-id="board-mcp-app-stale"]');
const waitForApp = (cell: BoardWidgetCell) => vi.waitFor(() => expect(app(cell)).not.toBeNull());
function mountLease(
  viewId: string,
  expiresAtMs: number,
  refreshWidgetAppView: BoardWidgetCellCallbacks["refreshWidgetAppView"],
) {
  return mount(
    widget(),
    callbacks({
      widgetAppView: vi.fn(async () => readyAppView(viewId, expiresAtMs)),
      refreshWidgetAppView,
    }),
  );
}
async function advance(cell: BoardWidgetCell, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle(cell);
}

function stubVisibility(visible: (index: number) => boolean): {
  disconnect: ReturnType<typeof vi.fn>;
  observed: () => number;
  emit: () => void;
} {
  let observed = 0;
  let emit = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        const index = observed;
        observed += 1;
        vi.spyOn(target, "getBoundingClientRect").mockImplementation(
          () =>
            ({
              bottom: visible(index) ? 200 : 5_200,
              top: visible(index) ? 0 : 5_000,
            }) as DOMRect,
        );
        emit = () =>
          this.callback(
            [{ isIntersecting: visible(index), target } as IntersectionObserverEntry],
            this as never,
          );
        emit();
      }
      disconnect = disconnect;
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
  return { disconnect, observed: () => observed, emit: () => emit() };
}

function stubChangingVisibility() {
  let visible = true;
  const observer = stubVisibility(() => visible);
  return (next: boolean) => {
    visible = next;
    observer.emit();
  };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("board MCP App cell lifecycle", () => {
  it("waits to materialize an inactive cell until its board becomes active", async () => {
    const visibility = stubVisibility(() => true);
    const widgetAppView = vi.fn(async () => readyAppView("activated-view"));
    const cell = await mount(widget(), callbacks({ widgetAppView }), false);

    expect(visibility.observed()).toBe(0);
    expect(widgetAppView).not.toHaveBeenCalled();
    expect(app(cell)).toBeNull();

    cell.active = true;
    await settle(cell);
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(app(cell)).not.toBeNull();
  });

  it("shows pending access notices above container-sized apps", async () => {
    const cell = await mount(
      widget({ grantState: "pending" }),
      callbacks({
        widgetAppView: vi.fn(async () => readyAppView("fixed-view")),
      }),
    );
    await waitForApp(cell);

    expect(app(cell)).toMatchObject({
      fillContainer: true,
      sessionKey: "agent:main:test",
      viewId: "fixed-view",
    });
    expect(cell.querySelector('[data-test-id="board-pending"]')).not.toBeNull();

    cell.widget = widget({ grantState: "granted" });
    await settle(cell);
    expect(app(cell)).not.toBeNull();
    expect(cell.querySelector('[data-test-id="board-pending"]')).toBeNull();
  });

  it("keeps active offscreen behavior while retaining inactive ready views", async () => {
    const setVisible = stubChangingVisibility();
    const widgetAppView = vi.fn(async () => readyAppView("viewport-view"));
    const cell = await mount(widget(), callbacks({ widgetAppView }));
    await waitForApp(cell);
    const initialView = app(cell);

    setVisible(false);
    await settle(cell);
    expect(app(cell)).toBeNull();

    setVisible(true);
    await settle(cell);
    const remountedView = app(cell);
    expect(remountedView).not.toBeNull();
    expect(remountedView).not.toBe(initialView);
    expect(widgetAppView).toHaveBeenCalledOnce();

    cell.active = false;
    await settle(cell);
    expect(app(cell)).toBe(remountedView);
    cell.active = true;
    await settle(cell);
    expect(app(cell)).toBe(remountedView);
    expect(remountedView?.teardown).not.toHaveBeenCalled();
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("lets an in-flight materialization finish while inactive without duplicating it", async () => {
    stubVisibility(() => true);
    const appView = deferred<BoardWidgetAppViewState>();
    const widgetAppView = vi.fn(() => appView.promise);
    const cell = await mount(widget(), callbacks({ widgetAppView }));
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());

    cell.active = false;
    await settle(cell);
    appView.resolve(readyAppView("finished-hidden"));
    await settle(cell);
    expect(app(cell)?.viewId).toBe("finished-hidden");

    cell.active = true;
    await settle(cell);
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("awaits native teardown before replacing an expired app with its stale notice", async () => {
    const retired = deferred();
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "stale" as const,
      error: "lease rejected",
    }));
    const cell = await mount(widget(), callbacks({ refreshWidgetAppView }));
    await waitForApp(cell);
    const view = app(cell)!;
    const teardown = vi.spyOn(view, "teardown").mockImplementation(() => retired.promise);
    view.dispatchEvent(
      new CustomEvent("openclaw-mcp-app-view-expired", { bubbles: true, composed: true }),
    );
    await settle(cell);

    expect(teardown).toHaveBeenCalled();
    expect(app(cell)).toBe(view);
    expect(stale(cell)).toBeNull();
    retired.resolve();
    await settle(cell);
    expect(app(cell)).toBeNull();
    expect(stale(cell)).not.toBeNull();
  });

  it("keeps a short renewed lease until expiry without another refresh loop", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const refreshWidgetAppView = vi.fn(async () => readyAppView("short-renewed-view", 5_000));
    const cell = await mountLease("near-expiry-view", 5_000, refreshWidgetAppView);
    await advance(cell, 0);

    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect(app(cell)).not.toBeNull();
    await advance(cell, 4_000);

    expect(stale(cell)).not.toBeNull();
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
  });

  it("cleans up visibility when an MCP App cell becomes HTML", async () => {
    const visibility = stubVisibility(() => true);
    const widgetAppView = vi.fn(async () => readyAppView("converted-view"));
    const currentCallbacks = callbacks({ widgetAppView });
    const cell = await mount(widget({ contentKind: "html" }), currentCallbacks);

    cell.widget = widget();
    await settle(cell);
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(visibility.observed()).toBe(1);

    cell.widget = widget({ contentKind: "html" });
    await settle(cell);
    expect(visibility.disconnect).toHaveBeenCalledOnce();
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("recovers when a slow renewal finishes after the expiry watchdog", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mountLease("short-view", 11_000, refreshWidgetAppView);
    await advance(cell, 0);
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();

    await advance(cell, 1_000);
    expect(stale(cell)).not.toBeNull();

    remint.resolve(readyAppView("late-view", 30_000));
    await settle(cell);
    expect(app(cell)?.viewId).toBe("late-view");
  });

  it("keeps a valid lease mounted when proactive renewal fails", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const cell = await mountLease(
      "still-valid-view",
      20_000,
      vi.fn(async () => ({
        status: "stale" as const,
        error: "temporary gateway failure",
      })),
    );

    await advance(cell, 5_000);
    expect(app(cell)?.viewId).toBe("still-valid-view");

    await advance(cell, 5_000);
    expect(stale(cell)).not.toBeNull();
  });

  it("keeps the expiry watchdog when a renewing app moves offscreen", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const setVisible = stubChangingVisibility();
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mountLease("short-view", 11_000, refreshWidgetAppView);
    await advance(cell, 0);

    setVisible(false);
    await settle(cell);
    await vi.advanceTimersByTimeAsync(1_000);
    setVisible(true);
    await settle(cell);

    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect(stale(cell)).not.toBeNull();
  });

  it("does not remint a short renewed lease when it returns onscreen", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const setVisible = stubChangingVisibility();
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mountLease("first-view", 20_000, refreshWidgetAppView);
    await vi.advanceTimersByTimeAsync(5_000);
    setVisible(false);
    remint.resolve(readyAppView("short-renewed", 18_000));
    await settle(cell);

    setVisible(true);
    await settle(cell);
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect(app(cell)?.viewId).toBe("short-renewed");

    await advance(cell, 3_000);
    expect(stale(cell)).not.toBeNull();
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
  });

  it("restarts materialization when a disconnected cell is reattached", async () => {
    const widgetAppView = vi.fn(async () => readyAppView("reattached-view"));
    const cell = await mount(widget(), callbacks({ widgetAppView }));
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());

    cell.remove();
    await Promise.resolve();
    mountElement(cell);
    await settle(cell);

    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledTimes(2));
    expect(app(cell)).not.toBeNull();
  });
});
