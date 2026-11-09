import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import { buildPeakErrorHours } from "./metrics.ts";
import { createUsageOverview } from "./view.test-support.ts";

it("renders server hours as named focusable toggles and preserves shift selection", () => {
  const overview = createUsageOverview({
    hourTokens: Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 10000 : 0)),
    hasTimelineData: true,
  });
  const [selectedHours, select] = createSignal([10]);
  const onSelectHour = vi.fn((hour: number, _shift: boolean) =>
    select((current) => (current.includes(hour) ? [] : [hour])),
  );
  const container = document.createElement("div");
  document.body.append(container);
  mountSolid(
    () =>
      UsageMosaic({
        overview,
        timeZone: "utc",
        get selectedHours() {
          return selectedHours();
        },
        onSelectHour,
      }),
    { container },
  );
  flush();
  const cells = container.querySelectorAll<HTMLButtonElement>(".usage-hour-cell");
  const selected = cells[10]!;
  expect(selected.getAttribute("aria-label")).toBe("10:00 · 10.0K tokens");
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  selected.focus();
  selected.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  expect(onSelectHour).toHaveBeenCalledWith(10, true);
  flush();
  expect(cells[10]).toBe(selected);
  expect(document.activeElement).toBe(selected);
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  cells[11]!.click();
  expect(onSelectHour).toHaveBeenCalledWith(11, false);
  container.remove();
});

it("formats the five highest nonzero server error rates", () => {
  expect(
    buildPeakErrorHours(Array(8).fill(100), [2, 4, 6, 8, 10, 12, 14, 16]).map(({ value, sub }) => ({
      value,
      sub,
    })),
  ).toEqual(
    [16, 14, 12, 10, 8].map((errors) => ({
      value: `${errors.toFixed(2)}%`,
      sub: `${errors} errors · 100 msgs`,
    })),
  );
  expect(buildPeakErrorHours([10, 0], [0, 1])).toEqual([]);
});
