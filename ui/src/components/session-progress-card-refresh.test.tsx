/* @vitest-environment jsdom */
import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  SessionProgressCard,
  type SessionProgressCardProps,
} from "./session-progress-card-view.tsx";
import type { SessionProgressCardRefreshAction } from "./session-progress-card.ts";

const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);

const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

describe("progress card refresh control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each([false, true])(
    "refreshes from the header without toggling or dragging (collapsed: %s)",
    async (collapsed) => {
      const onRefresh = vi.fn();
      const onManipulate = vi.fn();
      const [state, setState] = createSignal<SessionProgressCardRefreshAction["state"]>();
      const { container } = mountSolid(() => (
        <SessionProgressCard
          card={progressCard}
          placement="composer"
          collapseComposerByDefault={collapsed}
          composerDisclosureContext={{ onManipulate }}
          refreshAction={{ onRefresh, state: state() }}
        />
      ));
      const show = (next?: SessionProgressCardRefreshAction["state"]) => {
        setState(next);
        flush();
      };
      show();
      await Promise.resolve();
      const details = container.querySelector("details")!;
      const summary = container.querySelector("summary")!;
      const button = container.querySelector<HTMLButtonElement>(".session-progress-card__refresh")!;
      expect(button.closest(".session-progress-card__summary-expanded")).toBeNull();
      expect(button.getAttribute("aria-label")).toBe("Refresh task progress");
      expect(button.querySelector("svg path")).not.toBeNull();
      const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 100 });
      Object.defineProperties(down, { isPrimary: { value: true }, pointerId: { value: 1 } });
      button.dispatchEvent(down);
      summary.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 50 }));
      button.click();
      expect(onRefresh).toHaveBeenCalledExactlyOnceWith(progressCard);
      expect(onManipulate).not.toHaveBeenCalled();
      expect(details.open).toBe(!collapsed);
      show("pending");
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
      button.click();
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[role=status]")?.textContent).toContain(
        "Refreshing task progress",
      );
      expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
        new Date(progressCard.updatedAt).toISOString(),
      );
      show("failed");
      expect(container.textContent).not.toContain("Use refresh to retry");
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Retry progress refresh");
      expect(container.querySelector("[role=status]")?.textContent).toContain(
        "Previous update kept",
      );
      button.click();
      expect(onRefresh).toHaveBeenCalledTimes(2);
      show("timeout");
      expect(container.textContent).not.toContain("Use refresh to retry");
      expect(container.querySelector("[role=status]")?.textContent).toContain(
        "may still be running",
      );
      expect(details.open).toBe(!collapsed);
      show("updated");
      expect(container.querySelector("[role=status]")?.textContent).toBe("Task progress updated");
      expect(details.open).toBe(!collapsed);
      summary.click();
      expect(details.open).toBe(collapsed);
    },
  );

  it("uses a fresh saved timestamp rather than an older completed run after reload", () => {
    const { container } = mountSolid(() => (
      <SessionProgressCard
        card={{ ...progressCard, updatedAt: NOW_MS }}
        placement="composer"
        sessionStatus="done"
        startedAt={NOW_MS - 120_000}
        endedAt={NOW_MS - 60_000}
        hasActiveRun={false}
      />
    ));
    expect(container.querySelector("time")?.textContent).toBe("Updated just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(container.querySelector("[data-outcome=done]")).toBeNull();
    expect(container.querySelector(".session-progress-card__step--paused")).not.toBeNull();
  });

  it("does not expose refresh on read-only board cards", () => {
    const { container } = mountSolid(() => (
      <SessionProgressCard
        card={progressCard}
        placement="board"
        refreshAction={{ onRefresh: vi.fn() }}
      />
    ));
    expect(container.querySelector(".session-progress-card__refresh")).toBeNull();
  });

  it("retains manual disclosure across card updates and retires absent cards", () => {
    const [card, setCard] = createSignal<ProgressCard | null>(null);
    const { container } = mountSolid(() => (
      <SessionProgressCard card={card()} placement="composer" />
    ));
    expect(container.querySelector("details")).toBeNull();
    setCard(progressCard);
    flush();
    const details = container.querySelector("details")!;
    details.querySelector("summary")!.click();
    expect(details.open).toBe(false);
    setCard({ ...progressCard, revision: 3, markdown: "**Updated progress**" });
    flush();
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.querySelector("strong")?.textContent).toBe("Updated progress");
    setCard(null);
    flush();
    expect(container.querySelector("details")).toBeNull();
    // Deliver jsdom's queued details toggle without advancing the 30s activity interval.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires disclosure listeners when changing to a board card", () => {
    const [placement, setPlacement] =
      createSignal<SessionProgressCardProps["placement"]>("composer");
    const { container } = mountSolid(() => (
      <SessionProgressCard card={progressCard} placement={placement()} />
    ));
    const details = container.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    setPlacement("board");
    flush();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("section")?.dataset.progressCardPlacement).toBe("board");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    summary.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    // Native details toggle delivery is a task, separate from the owned activity timer.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(1);
    setPlacement("details");
    flush();
    expect(container.querySelector("details")?.open).toBe(true);
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes relative activity while mounted and clears its timer on unmount", () => {
    const { container, unmount } = mountSolid(() => (
      <SessionProgressCard
        card={{ ...progressCard, updatedAt: NOW_MS - 10_000 }}
        placement="composer"
      />
    ));
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("Updated just now");
    vi.advanceTimersByTime(60_000);
    flush();
    expect(time.textContent).toBe("Updated 1m ago");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
