// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./elapsed-time.tsx";

type ElapsedTimeElement = HTMLElementTagNameMap["openclaw-elapsed-time"];

const NOW = 2_000_000_000;

describe("openclaw-elapsed-time", () => {
  let element: ElapsedTimeElement;
  let visibility: DocumentVisibilityState;
  let observer: MutationObserver;

  const observeText = () => {
    const changed = vi.fn();
    observer = new MutationObserver(changed);
    observer.observe(element, { characterData: true, childList: true, subtree: true });
    return changed;
  };

  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.useFakeTimers({ now: NOW });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    element = document.createElement("openclaw-elapsed-time");
    element.startMs = NOW;
    document.body.appendChild(element);
  });

  afterEach(() => {
    observer?.disconnect();
    element.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["minute", false, 65_000, 54_000, "1m", "1m", "2m", 0],
    ["second", true, 61_000, 28_000, "1m", "1m", "2m", 0],
    ["second", false, 3_600_000, 1_000, "1h", "1h 1s", "1h 2s", 1],
  ] as const)(
    "updates %s labels only when their displayed duration changes (single unit: %s, elapsed: %i)",
    async (minimumUnit, singleUnit, elapsedMs, advanceMs, initial, first, second, renders) => {
      element.minimumUnit = minimumUnit;
      element.singleUnit = singleUnit;
      element.startMs = NOW - elapsedMs;
      await element.updateComplete;
      expect(element.textContent?.trim()).toBe(initial);
      const changed = observeText();
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(changed).toHaveBeenCalledTimes(renders);
      expect(element.textContent?.trim()).toBe(first);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(changed).toHaveBeenCalledTimes(renders + 1);
      expect(element.textContent?.trim()).toBe(second);
    },
  );

  it("applies timing and format property changes even when the current label is unchanged", async () => {
    element.minimumUnit = "minute";
    element.startMs = NOW - 65_000;
    await element.updateComplete;
    element.endMs = NOW;
    await element.updateComplete;
    const changed = observeText();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).not.toHaveBeenCalled();
    expect(element.textContent?.trim()).toBe("1m");

    element.endMs = null;
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("2m");
    element.minimumUnit = "second";
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("2m 5s");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(element.textContent?.trim()).toBe("2m 6s");
  });

  it("pauses hidden polling, catches up on return, and stops after removal", async () => {
    await element.updateComplete;
    const changed = observeText();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).not.toHaveBeenCalled();
    expect(element.textContent?.trim()).toBe("1s");

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    expect(element.textContent?.trim()).toBe("1m");

    element.remove();
    // Settle bridge disposal and the resulting observer notification before checking for ticks.
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changed).not.toHaveBeenCalled();
  });
});
