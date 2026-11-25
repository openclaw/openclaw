import { expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { totals } from "./usage-chart.test-support.ts";
import { renderSessionSummary } from "./view-session-summary.tsx";

it("uses native localized ranges and USD for session summary activity and costs", () => {
  const locale = vi.spyOn(i18n, "getLocale").mockReturnValue("de");
  const first = Date.UTC(2026, 0, 2, 12, 0);
  const last = Date.UTC(2026, 0, 2, 13, 30);
  const view = mountSolid(() =>
    renderSessionSummary({
      key: "example",
      usage: {
        ...totals,
        totalCost: 1234.5,
        modelUsage: [
          {
            provider: "example",
            model: "example",
            count: 1,
            totals: { ...totals, totalCost: 1234.5 },
          },
        ],
        firstActivity: first,
        lastActivity: last,
      },
    }),
  );
  try {
    expect(view.container.textContent).toContain(
      new Intl.DateTimeFormat("de", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).formatRange(first, last),
    );
    expect(view.container.textContent).toContain(
      new Intl.NumberFormat("de", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(1234.5),
    );
  } finally {
    view.unmount();
    locale.mockRestore();
  }
});
