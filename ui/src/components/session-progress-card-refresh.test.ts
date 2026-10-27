/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  cardPart,
  advance,
  NOW_MS,
  progressCard,
  progressCardFixture,
} from "./session-progress-card.test-support.tsx";
import type { SessionProgressCardRefreshAction } from "./session-progress-card.ts";

const { mountCard, createView } = progressCardFixture();
const statusText = (root: HTMLElement) => root.querySelector("[role=status]")?.textContent;
const time = (container: HTMLElement) => container.querySelector("time");

describe("progress card refresh control", () => {
  it.each([false, true])(
    "refreshes from the options menu without toggling or dragging (collapsed: %s)",
    async (collapsed) => {
      const onRefresh = vi.fn();
      const onManipulate = vi.fn();
      const { container, show: update } = createView({
        hasActiveRun: true,
        collapseComposerByDefault: collapsed,
        composerDisclosureContext: { onManipulate },
      });
      const show = (state?: SessionProgressCardRefreshAction["state"]) =>
        update({ refreshAction: { onRefresh, state } });
      show();
      expect(container.querySelector(".session-progress-card__refresh")).toBeNull();
      await Promise.resolve();
      const options = cardPart(container, "options")!;
      const openMenu = async () => {
        if (options.getAttribute("aria-expanded") !== "true") {
          options.click();
          flush();
          await vi.waitFor(() => expect(options.getAttribute("aria-expanded")).toBe("true"));
        }
      };
      await openMenu();
      const details = container.querySelector("details")!;
      const summary = container.querySelector("summary")!;
      const button = container.querySelector<HTMLButtonElement>(".session-progress-card__refresh")!;
      expect(button.closest(".session-progress-card__summary-expanded")).toBeNull();
      expect(button.textContent).toContain("Refresh task progress");
      expect(button.querySelector("svg path")).not.toBeNull();
      const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 100 });
      Object.defineProperties(down, { isPrimary: { value: true }, pointerId: { value: 1 } });
      button.dispatchEvent(down);
      summary.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 50 }));
      button.click();
      expect(onRefresh).toHaveBeenCalledExactlyOnceWith(progressCard);
      expect(onManipulate).not.toHaveBeenCalled();
      expect(details.open).toBe(!collapsed);
      for (const [state, status, calls] of [
        ["pending", "Refreshing task progress", 1],
        ["failed", "Previous update kept", 2],
        ["timeout", "may still be running", 3],
        ["updated", "Task progress updated", 4],
      ] as const) {
        show(state);
        await openMenu();
        expect(button.disabled).toBe(state === "pending");
        expect(button.getAttribute("aria-busy")).toBe(String(state === "pending"));
        expect(time(container)?.dateTime).toBe(new Date(progressCard.updatedAt).toISOString());
        expect(statusText(container)).toContain(status);
        expect(container.textContent).not.toContain("Use refresh to retry");
        expect(details.open).toBe(!collapsed);
        if (state === "failed") {
          expect(button.textContent).toContain("Retry progress refresh");
        }
        if (state === "updated") {
          expect(statusText(container)).toBe(status);
        }
        button.click();
        expect(onRefresh).toHaveBeenCalledTimes(calls);
      }
      options.click();
      flush();
      summary.click();
      expect(details.open).toBe(collapsed);
    },
  );

  it("uses a fresh saved timestamp rather than an older completed run after reload", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: NOW_MS },
      sessionStatus: "done",
      startedAt: NOW_MS - 120_000,
      endedAt: NOW_MS - 60_000,
      hasActiveRun: false,
    });
    expect(time(container)?.textContent).toBe("Updated just now");
    expect(time(container)?.dateTime).toBe(new Date(NOW_MS).toISOString());
    expect(container.querySelector("[data-outcome=done]")).toBeNull();
    expect(cardPart(container, "step--paused")).not.toBeNull();
  });

  it("does not expose refresh on read-only board cards", () => {
    const container = mountCard({
      placement: "board",
      hasActiveRun: true,
      collapseComposerByDefault: false,
      refreshAction: { onRefresh: vi.fn() },
    });
    expect(cardPart(container, "refresh")).toBeNull();
  });

  it("retains manual disclosure across card updates and retires absent cards", () => {
    const { container, show } = createView();
    show({ card: null });
    expect(container.querySelector("details")).toBeNull();
    show({ card: progressCard });
    const details = container.querySelector("details")!;
    details.querySelector("summary")!.click();
    expect(details.open).toBe(false);
    show({
      card: {
        ...progressCard,
        revision: 3,
        markdown: "**Updated progress**",
        steps: [{ step: "Wire the updated checklist", status: "in_progress" }],
      },
    });
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Wire the updated checklist");
    expect(details.querySelector("strong")?.textContent).toBe("Updated progress");
    show({ card: null });
    expect(container.querySelector("details")).toBeNull();
    // Deliver jsdom's queued details toggle without advancing the 30s activity interval.
    advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires disclosure listeners when changing to a board card", () => {
    const { container, show } = createView();
    show({ placement: "composer" });
    const summary = container.querySelector("summary")!;
    show({ placement: "board" });
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("section")?.dataset.progressCardPlacement).toBe("board");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    summary.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    // Settle native toggle delivery and deferred scroll geometry before counting activity timers.
    vi.advanceTimersToNextFrame();
    flush();
    expect(vi.getTimerCount()).toBe(1);
    show({ placement: "details" });
    expect(container.querySelector("details")?.open).toBe(true);
    vi.advanceTimersToNextFrame();
    flush();
    // Details without refresh controls has no timestamp; the board activity timer retires.
    expect(container.querySelector("time")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
