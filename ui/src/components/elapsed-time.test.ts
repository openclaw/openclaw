// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./elapsed-time.ts";

type ElapsedTimeElement = HTMLElement & {
  startMs: number | null;
  endMs: number | null;
  minimumUnit: "second" | "minute";
  singleUnit: boolean;
  updateComplete: Promise<boolean>;
  render: () => unknown;
};

const NOW = 2_000_000_000;

describe("openclaw-elapsed-time", () => {
  let element: ElapsedTimeElement;
  let visibility: DocumentVisibilityState;

  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.useFakeTimers({ now: NOW });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    element = document.createElement("openclaw-elapsed-time") as ElapsedTimeElement;
    element.startMs = NOW;
    document.body.appendChild(element);
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { minimumUnit: "minute", singleUnit: false, elapsedMs: 65_000, unchangedMs: 54_000 },
    { minimumUnit: "second", singleUnit: true, elapsedMs: 61_000, unchangedMs: 28_000 },
  ] as const)(
    "skips unchanged $minimumUnit labels (single unit: $singleUnit) and preserves rounding",
    async ({ minimumUnit, singleUnit, elapsedMs, unchangedMs }) => {
      element.minimumUnit = minimumUnit;
      element.singleUnit = singleUnit;
      element.startMs = NOW - elapsedMs;
      await element.updateComplete;
      expect(element.textContent?.trim()).toBe("1m");
      const render = vi.spyOn(element, "render");

      await vi.advanceTimersByTimeAsync(unchangedMs);
      expect(render).not.toHaveBeenCalled();
      expect(element.textContent?.trim()).toBe("1m");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(render).toHaveBeenCalledOnce();
      expect(element.textContent?.trim()).toBe("2m");
    },
  );

  it("continues showing seconds when compact formatting skips an empty minute", async () => {
    element.startMs = NOW - 3_600_000;
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("1h");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(element.textContent?.trim()).toBe("1h 1s");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(element.textContent?.trim()).toBe("1h 2s");
  });

  it("applies timing and format property changes even when the current label is unchanged", async () => {
    element.minimumUnit = "minute";
    element.startMs = NOW - 65_000;
    await element.updateComplete;
    element.endMs = NOW;
    await element.updateComplete;
    const render = vi.spyOn(element, "render");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(render).not.toHaveBeenCalled();
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
    const render = vi.spyOn(element, "render");
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(render).not.toHaveBeenCalled();
    expect(element.textContent?.trim()).toBe("1s");

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await element.updateComplete;
    expect(render).toHaveBeenCalledOnce();
    expect(element.textContent?.trim()).toBe("1m");

    element.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(render).toHaveBeenCalledOnce();
  });
});
