import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { testId, boardWidget } from "./board-view.test-support.ts";
import type {
  BoardWidgetCellCallbacks,
  BoardWidgetCellProps,
} from "./board-widget-cell-options.ts";
import {
  callbacks,
  cleanupCells,
  mountCell,
  mountElement,
} from "./board-widget-cell.test-support.ts";
import "./board-widget-cell.solid.tsx";

const mcpLoad = vi.hoisted(() => ({
  promise: Promise.resolve(),
  requested: vi.fn(),
  fail: false,
}));
// mock-isolation: Keep the controlled MCP host and deferred import independent of the real sandbox renderer.
vi.mock("../mcp-app-view.tsx", async () => {
  mcpLoad.requested();
  await mcpLoad.promise;
  return {
    McpAppView: (
      props: Parameters<typeof import("../mcp-app-view.tsx").McpAppView>[0] & {
        "onOpenclaw-mcp-app-view-expired"?: (event: Event) => void;
      },
    ) => {
      if (mcpLoad.fail) {
        throw new Error("MCP renderer temporarily unavailable");
      }
      return (
        <mcp-app-view
          ref={props.ref}
          class={props.class}
          prop:sessionKey={props.sessionKey}
          prop:viewId={props.viewId}
          prop:fillContainer={props.fillContainer}
          prop:surface={props.surface}
          title={props.title}
          onOpenclaw-mcp-app-view-expired={(event: Event) =>
            props["onOpenclaw-mcp-app-view-expired"]?.(event)
          }
        />
      );
    },
  };
});

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

async function mount(
  currentCallbacks: Partial<BoardWidgetCellCallbacks> = {},
  props: BoardWidgetCellProps = {},
): Promise<BoardWidgetCell> {
  const cell = mountCell(props.widget ?? widget(), {
    sessionKey: "agent:main:test",
    callbacks: callbacks({
      widgetAppView: vi.fn(async () => readyAppView("initial-view")),
      refreshWidgetAppView: vi.fn(async () => readyAppView("renewed-view")),
      ...currentCallbacks,
    }),
    ...props,
  });
  await settle(cell);
  return cell;
}

async function update(cell: BoardWidgetCell, props: BoardWidgetCellProps) {
  Object.assign(cell, props);
  await settle(cell);
}

async function settle(cell: BoardWidgetCell): Promise<void> {
  await Promise.resolve();
  await cell.updateComplete;
  await Promise.resolve();
  await cell.updateComplete;
}

const app = (cell: BoardWidgetCell) => cell.querySelector<TestMcpAppView>("mcp-app-view");
const stale = (cell: BoardWidgetCell) => testId(cell, "board-mcp-app-stale");
const actionError = (cell: BoardWidgetCell) => testId(cell, "board-widget-action-error");
const frameError = (cell: BoardWidgetCell) => testId(cell, "board-widget-error");
const scrollable = (cell: BoardWidgetCell) => cell.querySelector(".board-widget__body--scrollable");
const grantButton = (cell: BoardWidgetCell) =>
  cell.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')!;
const htmlWidget = (overrides: Partial<BoardWidget> = {}) =>
  widget({ contentKind: "html", ...overrides });
const waitForApp = (cell: BoardWidgetCell) => vi.waitFor(() => expect(app(cell)).not.toBeNull());
function mountLease(
  viewId: string,
  expiresAtMs: number,
  refreshWidgetAppView: BoardWidgetCellCallbacks["refreshWidgetAppView"],
) {
  return mount({
    widgetAppView: vi.fn(async () => readyAppView(viewId, expiresAtMs)),
    refreshWidgetAppView,
  });
}
async function pendingLease(expiresAtMs = 11_000) {
  vi.useFakeTimers({ now: 10_000 });
  const renewal = deferred<BoardWidgetAppViewState>();
  const refreshWidgetAppView = vi.fn(() => renewal.promise);
  const cell = await mountLease("initial-view", expiresAtMs, refreshWidgetAppView);
  return { cell, renewal, refreshWidgetAppView };
}
async function advance(cell: BoardWidgetCell, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle(cell);
}

function stubVisibility(visible: (index: number) => boolean) {
  let observed = 0;
  let emit = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        const index = observed;
        observed += 1;
        vi.spyOn(target, "getBoundingClientRect").mockImplementation(
          () => new DOMRect(0, visible(index) ? 0 : 5_000, 0, 200),
        );
        emit = () => {
          if (!this.targets.has(target)) {
            return;
          }
          this.callback(
            [{ isIntersecting: visible(index), target } as IntersectionObserverEntry],
            this as never,
          );
        };
        queueMicrotask(emit);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
        disconnect();
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
  cleanupCells();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("board MCP App cell lifecycle", () => {
  it("preloads before the lease and never revives a disposed cell after loading", async () => {
    const setVisible = stubChangingVisibility();
    const code = deferred();
    const lease = deferred<BoardWidgetAppViewState>();
    mcpLoad.promise = code.promise;
    mcpLoad.fail = true;
    onTestFinished(() => {
      code.resolve();
      lease.resolve(readyAppView("retired-view"));
      mcpLoad.fail = false;
    });

    const cancelled = await mount({ widgetAppView: () => lease.promise });
    await waitForSolid(() => expect(mcpLoad.requested).toHaveBeenCalledOnce());
    lease.resolve(readyAppView("retired-view"));
    await settle(cancelled);
    expect(testId(cancelled, "board-mcp-app-loading")).not.toBeNull();
    expect(app(cancelled)).toBeNull();
    cancelled.remove();
    await settle(cancelled);
    const retiredContent = cancelled.innerHTML;

    const current = await mount();
    expect(testId(current, "board-mcp-app-loading")).not.toBeNull();
    expect(app(current)).toBeNull();
    setVisible(false);
    await settle(current);
    code.resolve();
    await settle(current);
    expect(app(current)).toBeNull();
    expect(current.querySelector(".lazy-view-error")).toBeNull();
    setVisible(true);
    await waitForSolid(() =>
      expect(current.querySelector(".lazy-view-error")?.textContent).toContain(
        "MCP renderer temporarily unavailable",
      ),
    );
    mcpLoad.fail = false;
    current.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
    await waitForApp(current);
    expect(app(current)?.viewId).toBe("initial-view");
    expect(app(cancelled)).toBeNull();
    expect(cancelled.querySelector(".lazy-view-error")).toBeNull();
    expect(cancelled.innerHTML).toBe(retiredContent);
    expect(cancelled.isConnected).toBe(false);
  });

  it("admits one action per tick and restores controls after it fails", async () => {
    const removal = deferred();
    const retry = deferred();
    const remove = vi.fn().mockReturnValueOnce(removal.promise).mockReturnValueOnce(retry.promise);
    const cell = await mount({ remove }, { widget: htmlWidget({ grantState: "pending" }) });

    cell.selectMenuItem("remove");
    cell.selectMenuItem("remove");
    expect(remove).toHaveBeenCalledOnce();
    await settle(cell);

    const allow = grantButton(cell);
    expect(allow.disabled).toBe(true);
    removal.reject(new Error("Removal failed"));
    await settle(cell);

    await waitForSolid(() => expect(actionError(cell)?.textContent).toContain("Removal failed"));
    expect(allow.disabled).toBe(false);
    cell.selectMenuItem("remove");
    await settle(cell);
    expect(actionError(cell)).toBeNull();
    expect(grantButton(cell)).toBe(allow);
    expect(allow.disabled).toBe(true);
    retry.reject(new Error("Retry failed differently"));
    await settle(cell);
    expect(allow.disabled).toBe(false);
    await waitForSolid(() =>
      expect(actionError(cell)?.textContent).toContain("Retry failed differently"),
    );
  });

  it("does not publish an old action failure into a replacement widget", async () => {
    const removal = deferred();
    const current = htmlWidget({ grantState: "pending" });
    const cell = await mount({ remove: () => removal.promise }, { widget: current });
    cell.selectMenuItem("remove");
    await settle(cell);
    await update(cell, { widget: { ...current, name: "replacement" } });
    removal.reject(new Error("Retired widget failed"));
    await settle(cell);
    expect(actionError(cell)).toBeNull();
    expect(grantButton(cell)?.disabled).toBe(false);
  });

  it.each([
    ["board revision", 1, {}],
    ["widget name", 0, { name: "beta" }],
    ["widget instance", 0, { instanceId: "replacement-instance" }],
    ["widget revision", 0, { revision: 2 }],
  ] as const)(
    "retains action errors across unrelated updates and clears them on a new %s",
    async (_change, boardRevision, replacement) => {
      const current = htmlWidget({ grantState: "pending" });
      const cell = await mount(
        {
          remove: async () => {
            throw new Error("Removal failed");
          },
        },
        { widget: current },
      );
      cell.selectMenuItem("remove");
      await settle(cell);
      await waitForSolid(() => expect(actionError(cell)?.textContent).toContain("Removal failed"));

      await update(cell, { widget: { ...current, title: "Updated title" }, active: false });
      expect(actionError(cell)?.textContent).toContain("Removal failed");

      await update(cell, { boardRevision, widget: { ...current, ...replacement } });
      expect(actionError(cell)).toBeNull();
    },
  );

  it.each(["resolver replacement", "in-place revision"] as const)(
    "keeps failed frame retries visible and clears their presentation after %s",
    async (recovery) => {
      const current = htmlWidget();
      const cell = await mount({}, { widget: current });
      expect(frameError(cell)).not.toBeNull();
      expect(scrollable(cell)).not.toBeNull();

      await update(cell, {
        widgetFrameUrl: (_name, revision) => {
          if (recovery === "in-place revision" && revision === 2) {
            return "/recovered-frame";
          }
          throw new Error("Frame unavailable");
        },
      });
      expect(frameError(cell)?.textContent).toContain("Frame unavailable");
      expect(scrollable(cell)).not.toBeNull();

      if (recovery === "in-place revision") {
        current.revision = 2;
        await update(cell, { boardRevision: 1 });
      } else {
        await update(cell, { widgetFrameUrl: () => "/recovered-frame" });
      }
      expect(frameError(cell)).toBeNull();
      expect(scrollable(cell)).toBeNull();
      expect(cell.querySelector("iframe")?.getAttribute("src")).toBe("/recovered-frame");
    },
  );

  it("refreshes an in-place HTML widget when its board revision changes", async () => {
    const current = htmlWidget();
    const cell = await mount(
      {},
      {
        widget: current,
        widgetFrameUrl: (name, revision) => `/widget/${name}/${revision}`,
      },
    );
    const frame = cell.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/widget/alpha/1");

    current.revision = 2;
    current.title = "Updated HTML widget";
    await update(cell, { boardRevision: 1 });

    expect(cell.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe("/widget/alpha/2");
    expect(frame.title).toBe("Updated HTML widget");
  });

  it("waits to materialize an inactive cell until its board becomes active", async () => {
    const visibility = stubVisibility(() => true);
    const widgetAppView = vi.fn(async () => readyAppView("activated-view"));
    const cell = await mount({ widgetAppView }, { active: false });
    expect(visibility.observed()).toBe(0);
    expect(widgetAppView).not.toHaveBeenCalled();
    expect(app(cell)).toBeNull();
    await update(cell, { active: true });
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(app(cell)).not.toBeNull();
  });

  it("shows pending access notices above container-sized apps", async () => {
    const cell = await mount(
      { widgetAppView: vi.fn(async () => readyAppView("fixed-view")) },
      { widget: widget({ grantState: "pending" }) },
    );
    await waitForApp(cell);
    expect(app(cell)).toMatchObject({
      fillContainer: true,
      sessionKey: "agent:main:test",
      viewId: "fixed-view",
    });
    expect(testId(cell, "board-pending")).not.toBeNull();
    await update(cell, { widget: widget({ grantState: "granted" }) });
    expect(app(cell)).not.toBeNull();
    expect(testId(cell, "board-pending")).toBeNull();
  });

  it("keeps active offscreen behavior while retaining inactive ready views", async () => {
    const setVisible = stubChangingVisibility();
    const widgetAppView = vi.fn(async () => readyAppView("viewport-view"));
    const cell = await mount({ widgetAppView });
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
    await update(cell, { active: false });
    expect(app(cell)).toBe(remountedView);
    await update(cell, { active: true });
    expect(app(cell)).toBe(remountedView);
    expect(remountedView?.teardown).not.toHaveBeenCalled();
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("updates ready leases and titles without replacing the native view", async () => {
    const { cell, renewal } = await pendingLease(20_000);
    await waitForApp(cell);
    const view = app(cell)!;
    await update(cell, { active: false, widget: widget({ title: "Updated app" }) });
    expect(app(cell)).toBe(view);
    expect(view.title).toBe("Updated app");
    await update(cell, { active: true });
    expect(app(cell)).toBe(view);
    expect(view.teardown).not.toHaveBeenCalled();
    await advance(cell, 5_000);
    renewal.resolve(readyAppView("renewed-view", 30_000));
    await settle(cell);
    expect(app(cell)).toBe(view);
    expect(view.viewId).toBe("renewed-view");
  });

  it("lets an in-flight materialization finish while inactive without duplicating it", async () => {
    stubVisibility(() => true);
    const appView = deferred<BoardWidgetAppViewState>();
    const widgetAppView = vi.fn(() => appView.promise);
    const cell = await mount({ widgetAppView });
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    await update(cell, { active: false });
    appView.resolve(readyAppView("finished-hidden"));
    await settle(cell);
    expect(app(cell)?.viewId).toBe("finished-hidden");
    await update(cell, { active: true });
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("awaits native teardown before replacing an expired app with its stale notice", async () => {
    const retired = deferred();
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "stale" as const,
    }));
    const cell = await mount({ refreshWidgetAppView });
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
    const cell = await mount({ widgetAppView }, { widget: htmlWidget() });
    await update(cell, { widget: widget() });
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(visibility.observed()).toBe(1);
    await update(cell, { widget: htmlWidget() });
    expect(visibility.disconnect).toHaveBeenCalledOnce();
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("recovers when a slow renewal finishes after the expiry watchdog", async () => {
    const { cell, renewal, refreshWidgetAppView } = await pendingLease();
    await advance(cell, 0);
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    await advance(cell, 1_000);
    expect(stale(cell)).not.toBeNull();
    renewal.resolve(readyAppView("late-view", 30_000));
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
      })),
    );
    await advance(cell, 5_000);
    expect(app(cell)?.viewId).toBe("still-valid-view");
    await advance(cell, 5_000);
    expect(stale(cell)).not.toBeNull();
  });

  it("keeps the expiry watchdog when a renewing app moves offscreen", async () => {
    const setVisible = stubChangingVisibility();
    const { cell, refreshWidgetAppView } = await pendingLease();
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
    const setVisible = stubChangingVisibility();
    const { cell, renewal, refreshWidgetAppView } = await pendingLease(20_000);
    await vi.advanceTimersByTimeAsync(5_000);
    setVisible(false);
    renewal.resolve(readyAppView("short-renewed", 18_000));
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
    const cell = await mount({ widgetAppView });
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    cell.remove();
    await Promise.resolve();
    mountElement(cell);
    await settle(cell);
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledTimes(2));
    expect(app(cell)).not.toBeNull();
  });
});
