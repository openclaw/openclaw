import { afterEach, expect, it, vi } from "vitest";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../styles.css";
import "../../styles/usage.css";
import { usageState } from "./view-render.test-support.ts";
import { buildAggregatesFromSessions, usageSession, usageTotals } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

registerUsageEnglish();

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

const inView = (element: Element | null, viewport: Element) => {
  const box = element!.getBoundingClientRect();
  const port = viewport.getBoundingClientRect();
  return box.top >= port.top - 1 && box.top < port.bottom;
};

it("reveals the detail panel on a phone row tap and returns to the row on close", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(390, 844);
  const sessions = Array.from({ length: 6 }, (_, index) =>
    usageSession(`agent:main:session-${index}`, "main", "openai"),
  );
  const state = usageState({}, (base) => ({
    ...base,
    sessions,
    totals: usageTotals(120, 1),
    aggregates: buildAggregatesFromSessions(sessions),
  }));
  const { usage, setFilters } = state;
  const select = (selectedSessions: string[]) =>
    setFilters((current) => ({ ...current, selectedSessions }));
  usage.callbacks.details.onSelectSession = (key) => select([key]);
  usage.callbacks.filters.onClearSessions = () => select([]);

  const { container } = mountSolid(() => (
    <div id="scroller" style={{ height: "100vh", overflow: "auto" }}>
      {renderUsage(usage)}
      <div style={{ height: "3000px" }} />
    </div>
  ));
  const scroller = container.querySelector("#scroller")!;
  await waitForSolid(() => expect(container.querySelector(".session-bar-row")).not.toBeNull());
  const rows = container.querySelectorAll<HTMLElement>(".session-bar-row");
  const row = rows[2]!;
  row.scrollIntoView({ block: "center" });

  row.querySelector("button")!.click();
  await waitForSolid(() => {
    const panel = container.querySelector(".session-detail-panel");
    expect(panel).not.toBeNull();
    expect(inView(panel, scroller)).toBe(true);
  });

  // The X shares the title row instead of taking a line of its own.
  const title = container.querySelector(".session-detail-title")!.getBoundingClientRect();
  const close = container.querySelector<HTMLElement>(".session-detail-close")!;
  expect(close.getBoundingClientRect().top).toBeLessThan(title.bottom);
  expect(close.getBoundingClientRect().left).toBeGreaterThan(title.left);

  scroller.scrollTop += 400;
  close.click();
  await waitForSolid(() => {
    expect(container.querySelector(".session-detail-panel")).toBeNull();
    expect(inView(row, scroller)).toBe(true);
  });
  expect(document.activeElement).toBe(row.querySelector("button"));
});
