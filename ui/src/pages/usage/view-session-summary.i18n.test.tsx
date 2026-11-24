import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { i18n } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderSessionSummary } from "./view-session-summary.tsx";

registerUsageEnglish();
afterEach(() => vi.restoreAllMocks());

it("uses whole templates for message-role counts and unique tools", () => {
  const translate = vi.spyOn(i18n, "t");
  const messageParams = { user: "3", assistant: "2" };
  const expectedMessages = i18n.t("usage.overview.messageCounts", messageParams);
  const expectedTools = i18n.t("usage.overview.uniqueToolsCount", { count: "4" });
  translate.mockClear();
  const { container, unmount } = mountSolid(() =>
    renderSessionSummary({
      key: "agent:main:test",
      usage: {
        ...createEmptyCostUsageTotals(),
        messageCounts: { total: 5, user: 3, assistant: 2, toolCalls: 6, toolResults: 6, errors: 0 },
        toolUsage: { totalCalls: 6, uniqueTools: 4, tools: [] },
      },
    }),
  );
  try {
    expect.soft(translate).toHaveBeenCalledWith("usage.overview.messageCounts", messageParams);
    expect.soft(translate).toHaveBeenCalledWith("usage.overview.uniqueToolsCount", { count: "4" });
    expect(container.textContent).toContain(expectedMessages);
    expect(container.textContent).toContain(expectedTools);
  } finally {
    unmount();
  }
});
