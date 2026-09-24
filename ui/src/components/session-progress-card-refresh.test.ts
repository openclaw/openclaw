/* @vitest-environment jsdom */
import type { ProgressCard } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderSessionProgressCard,
  type SessionProgressCardRefreshAction,
} from "./session-progress-card.ts";

const containers: HTMLDivElement[] = [];
function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

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
    for (const container of containers.splice(0)) {
      render(nothing, container);
      container.remove();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each([false, true])(
    "refreshes from the header without toggling or dragging (collapsed: %s)",
    async (collapsed) => {
      const container = createContainer();
      const onRefresh = vi.fn();
      const onManipulate = vi.fn();
      const show = (state?: SessionProgressCardRefreshAction["state"]) =>
        render(
          renderSessionProgressCard(
            progressCard,
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            collapsed,
            { onManipulate },
            { onRefresh, state },
          ),
          container,
        );
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
    const container = createContainer();
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: NOW_MS },
        "composer",
        undefined,
        "done",
        NOW_MS - 120_000,
        NOW_MS - 60_000,
        false,
      ),
      container,
    );
    expect(container.querySelector("time")?.textContent).toBe("Updated just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(container.querySelector("[data-outcome=done]")).toBeNull();
    expect(container.querySelector(".session-progress-card__step--paused")).not.toBeNull();
  });

  it("does not expose refresh on read-only board cards", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "board",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        false,
        undefined,
        { onRefresh: vi.fn() },
      ),
      container,
    );
    expect(container.querySelector(".session-progress-card__refresh")).toBeNull();
  });
});
