import { afterEach, describe, expect, it, vi } from "vitest";
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
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        const index = observed;
        observed += 1;
        vi.spyOn(target, "getBoundingClientRect").mockImplementation(
          () => new DOMRect(0, visible(index) ? 0 : 5_000, 0, 200),
        );
        emit = () =>
          this.callback(
            [{ isIntersecting: visible(index), target } as IntersectionObserverEntry],
            this as never,
          );
        emit();
      }
      disconnect = disconnect;
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
  it("admits one action per tick and restores controls after it fails", async () => {
    const removal = deferred();
    const retry = deferred();
    const remove = vi.fn().mockReturnValueOnce(removal.promise).mockReturnValueOnce(retry.promise);
    const cell = await mount(
      { remove },
      { widget: widget({ contentKind: "html", grantState: "pending" }) },
    );

    cell.selectMenuItem("remove");
    cell.selectMenuItem("remove");
    expect(remove).toHaveBeenCalledOnce();
    await settle(cell);

    const allow = cell.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')!;
    expect(allow.disabled).toBe(true);
    removal.reject(new Error("Removal failed"));
    await settle(cell);

    await waitForSolid(() =>
      expect(testId(cell, "board-widget-action-error")?.textContent).toContain("Removal failed"),
    );
    expect(allow.disabled).toBe(false);
    cell.selectMenuItem("remove");
    await settle(cell);
    expect(testId(cell, "board-widget-action-error")).toBeNull();
    expect(cell.querySelector('[data-test-id="board-grant-allow"]')).toBe(allow);
    expect(allow.disabled).toBe(true);
    retry.reject(new Error("Retry failed differently"));
    await settle(cell);
    expect(allow.disabled).toBe(false);
    await waitForSolid(() =>
      expect(testId(cell, "board-widget-action-error")?.textContent).toContain(
        "Retry failed differently",
      ),
    );
  });

  it("does not publish an old action failure into a replacement widget", async () => {
    const removal = deferred();
    const current = widget({ contentKind: "html", grantState: "pending" });
    const cell = await mount({ remove: () => removal.promise }, { widget: current });
    cell.selectMenuItem("remove");
    await settle(cell);
    await update(cell, { widget: { ...current, name: "replacement" } });
    removal.reject(new Error("Retired widget failed"));
    await settle(cell);
    expect(testId(cell, "board-widget-action-error")).toBeNull();
    expect(
      cell.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')?.disabled,
    ).toBe(false);
  });

  it.each([
    ["board revision", 1, {}],
    ["widget name", 0, { name: "beta" }],
    ["widget instance", 0, { instanceId: "replacement-instance" }],
    ["widget revision", 0, { revision: 2 }],
  ] as const)(
    "retains action errors across unrelated updates and clears them on a new %s",
    async (_change, boardRevision, replacement) => {
      const current = widget({ contentKind: "html", grantState: "pending" });
      const cell = await mount(
        {
          remove: async () => {
            throw new Error("Removal failed");
          },
        },
        { widget: current },
      );
      const error = () => testId(cell, "board-widget-action-error");
      cell.selectMenuItem("remove");
      await settle(cell);
      await waitForSolid(() => expect(error()?.textContent).toContain("Removal failed"));

      await update(cell, { widget: { ...current, title: "Updated title" }, active: false });
      expect(error()?.textContent).toContain("Removal failed");

      await update(cell, { boardRevision, widget: { ...current, ...replacement } });
      expect(error()).toBeNull();
    },
  );

  it.each(["resolver replacement", "in-place revision"] as const)(
    "keeps failed frame retries visible and clears their presentation after %s",
    async (recovery) => {
      const current = widget({ contentKind: "html" });
      const cell = await mount({}, { widget: current });
      expect(testId(cell, "board-widget-error")).not.toBeNull();
      expect(cell.querySelector(".board-widget__body--scrollable")).not.toBeNull();

      await update(cell, {
        widgetFrameUrl: (_name, revision) => {
          if (recovery === "in-place revision" && revision === 2) {
            return "/recovered-frame";
          }
          throw new Error("Frame unavailable");
        },
      });
      expect(testId(cell, "board-widget-error")?.textContent).toContain("Frame unavailable");
      expect(cell.querySelector(".board-widget__body--scrollable")).not.toBeNull();

      if (recovery === "in-place revision") {
        current.revision = 2;
        await update(cell, { boardRevision: 1 });
      } else {
        await update(cell, { widgetFrameUrl: () => "/recovered-frame" });
      }
      expect(testId(cell, "board-widget-error")).toBeNull();
      expect(cell.querySelector(".board-widget__body--scrollable")).toBeNull();
      expect(cell.querySelector("iframe")?.getAttribute("src")).toBe("/recovered-frame");
    },
  );

  it("refreshes an in-place HTML widget when its board revision changes", async () => {
    const current = widget({ contentKind: "html" });
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
    const cell = await mount({ widgetAppView }, { widget: widget({ contentKind: "html" }) });
    await update(cell, { widget: widget() });
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(visibility.observed()).toBe(1);
    await update(cell, { widget: widget({ contentKind: "html" }) });
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
