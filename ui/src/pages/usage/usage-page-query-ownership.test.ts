/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  createPage,
  focusDocument,
  preloadUsage,
  refreshButton,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

describe("Usage query failure ownership", () => {
  it("retains hidden charts and model options while a text query settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    focusDocument();
    const snapshot = cacheSnapshot("fresh");
    const date = "2026-08-07";
    const daily = dailyEntry(date, 200, 2);
    const original = {
      ...snapshot.result,
      totals: daily,
      aggregates: { ...snapshot.result.aggregates, costDaily: [daily] },
      sessions: ["synthetic-alpha", "synthetic-beta"].map((model) => ({
        key: `agent:main:${model}`,
        agentId: "main",
        label: `${model} session`,
        model,
        usage: {
          ...snapshot.result.totals,
          activityDates: [date],
          dailyBreakdown: [{ ...snapshot.result.totals, date, tokens: 100, cost: 1 }],
        },
      })),
    };
    let reply = deferred<typeof original>();
    let pending = false;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return pending ? reply.promise : original;
      }
      return { updatedAt: Date.now(), providers: [] };
    });
    // SAFETY: The fixture exercises only the mocked request method.
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.read().callbacks.filters.onDatesChange({ startDate: "2026-01-01" });
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;
    const trend = page.querySelector<HTMLElement>(".usage-trend-section")!;
    const chart = trend.querySelector(".daily-chart-compact")!;
    const bar = trend.querySelector(".daily-bar-wrapper")!;
    const heatmap = page.querySelector<HTMLElement>(".usage-heatmap")!;
    const heatmapHost = heatmap.closest(".settings-section")!.parentElement!;
    const cells = [...heatmap.querySelectorAll(".usage-heatmap__cell")];
    expect(cells.length).toBeGreaterThan(62);
    expect(cells.at(-1)?.getAttribute("aria-label")).toContain("200");
    expect(page.querySelector(".cost-breakdown-compact")).not.toBeNull();
    const trigger = page.querySelector<HTMLButtonElement>('[id="usage-filter-model:trigger"]')!;
    const menu = trigger.closest<HTMLElement>(".usage-filter-select")!;
    menu.addEventListener(
      "overlay-show",
      () => {
        // JSDOM has no scrolling layout; exercise the real Menu selection path.
        for (const item of menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')) {
          item.scrollIntoView = vi.fn();
        }
      },
      { once: true },
    );
    trigger.click();
    await page.updateComplete;
    const options = [...menu.querySelectorAll<HTMLButtonElement>(".usage-filter-option")];
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "synthetic-alpha",
      "synthetic-beta",
    ]);

    pending = true;
    options[0]!.click();
    page.read().callbacks.filters.onApplyQuery();
    await page.updateComplete;
    expect(page.read().filters.query.trim()).toBe("model:synthetic-alpha");
    expect(page.usageLoading).toBe(true);
    expect(page.read().data.totals).toBeNull();
    expect(page.read().data.overview).toBeUndefined();
    expect(page.textContent).not.toContain("synthetic-alpha session");
    expect(trend.isConnected).toBe(true);
    expect(trend.hidden).toBe(true);
    expect(trend.hasAttribute("inert")).toBe(true);
    expect(trend.style.display).toBe("none");
    expect(trend.querySelector(".daily-chart-compact")).toBe(chart);
    expect(trend.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(heatmap.isConnected).toBe(true);
    expect(heatmapHost.hidden).toBe(true);
    expect(heatmapHost.hasAttribute("inert")).toBe(true);
    expect(heatmapHost.style.display).toBe("none");
    expect(page.querySelector(".cost-breakdown-compact")).toBeNull();
    expect(page.querySelector(".usage-overview-card")).toBeNull();
    expect(page.querySelector(".usage-grid")).toBeNull();
    expect(menu.querySelectorAll(".usage-filter-option")[0]).toBe(options[0]);
    expect(menu.querySelectorAll(".usage-filter-option")[1]).toBe(options[1]);
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");

    reply.resolve(original);
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.usageLoading).toBe(false);
    expect(page.textContent).toContain("synthetic-alpha session");
    expect(page.textContent).not.toContain("synthetic-beta session");
    expect(trend.hidden).toBe(false);
    expect(trend.hasAttribute("inert")).toBe(false);
    expect(trend.style.display).toBe("");
    expect(trend.querySelector(".daily-chart-compact")).toBe(chart);
    expect(trend.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(heatmapHost.hidden).toBe(false);
    expect(heatmapHost.hasAttribute("inert")).toBe(false);
    expect(heatmapHost.style.display).toBe("contents");
    const currentCells = [...heatmap.querySelectorAll(".usage-heatmap__cell")];
    currentCells.forEach((cell, index) => expect(cell).toBe(cells[index]));
    expect(currentCells.at(-1)?.getAttribute("aria-label")).toContain("100");
    expect(page.querySelector(".cost-breakdown-compact")).not.toBeNull();

    reply = deferred<typeof original>();
    page.read().callbacks.filters.onQueryDraftChange("model:synthetic-beta");
    page.read().callbacks.filters.onApplyQuery();
    await page.updateComplete;
    reply.reject(new Error("Synthetic filter failed"));
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.textContent).toContain("Synthetic filter failed");
    expect(trend.hidden).toBe(true);
    expect(heatmapHost.hidden).toBe(true);
    expect(page.querySelector(".usage-grid")).toBeNull();
    expect(menu.querySelectorAll(".usage-filter-option")[0]).toBe(options[0]);
    expect(menu.querySelectorAll(".usage-filter-option")[1]).toBe(options[1]);
  });

  it("does not mount hidden charts for an incomplete zero cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    focusDocument();
    const snapshot = cacheSnapshot("partial");
    const zero = dailyEntry("2026-08-07", 0);
    const original = {
      ...snapshot.result,
      totals: zero,
      sessions: [{ key: "agent:main:uncomputed", usage: zero }],
    };
    const reply = deferred<typeof original>();
    let pending = false;
    const request = vi.fn(async (method: string) =>
      method === "sessions.usage"
        ? pending
          ? reply.promise
          : original
        : { updatedAt: Date.now(), providers: [] },
    );
    // SAFETY: The fixture exercises only the mocked request method.
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.read().callbacks.filters.onDatesChange({ startDate: "2026-01-01" });
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;
    expect(page.querySelector(".usage-loading-card")).not.toBeNull();
    expect(page.querySelector(".daily-chart-compact")).toBeNull();
    pending = true;
    page.read().callbacks.filters.onQueryDraftChange("model:synthetic-alpha");
    page.read().callbacks.filters.onApplyQuery();
    await page.updateComplete;
    expect(page.usageLoading).toBe(true);
    expect(page.querySelector(".daily-chart-compact")).toBeNull();
    expect(page.querySelector(".usage-heatmap")).toBeNull();
    reply.resolve(original);
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
  });

  it.each(["start date", "end date", "scope", "time zone", "agent", "creator"] as const)(
    "does not attribute cached or late results to a changed %s",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
      focusDocument();
      const snapshot = cacheSnapshot("fresh");
      const original = {
        ...snapshot.result,
        aggregates: {
          ...snapshot.result.aggregates,
          costDaily: [dailyEntry("2026-08-07", 100, 1)],
        },
        creatorOptions: [
          { key: "profile:opaque-alex", actor: { type: "human" as const, label: "Alex Morgan" } },
        ],
        sessions: [
          {
            key: "agent:main:old",
            agentId: "main",
            label: "Old query row",
            usage: snapshot.result.totals,
          },
        ],
      };
      const oldReply = deferred<typeof original>();
      const newReply = deferred<typeof original>();
      let phase: "initial" | "old" | "new" = "initial";
      const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === "sessions.usage") {
          return phase === "initial"
            ? original
            : phase === "old"
              ? oldReply.promise
              : newReply.promise;
        }
        if (method === "sessions.usage.timeseries") {
          return { points: [] };
        }
        if (method === "sessions.usage.logs") {
          return { logs: [] };
        }
        return {
          updatedAt: Date.now(),
          providers: [{ provider: "openai", displayName: "QA Provider Plan", windows: [] }],
        };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const baseContext = contextWithClient(client);
      const selection = createAgentSelectionCapability(
        {
          connection: { gatewayUrl: "ws://qa.invalid" },
          snapshot: { assistantAgentId: null },
          subscribe: () => () => {},
        },
        baseContext.agents,
      );
      const context = { ...baseContext, agentSelection: selection };
      try {
        const page = await createPage(client, true, context);
        await preloadUsage(page);
        page.read().callbacks.filters.onDatesChange({ startDate: "2026-01-01" });
        await vi.advanceTimersByTimeAsync(400);
        await page.updateComplete;
        const originalChart = page.querySelector(".daily-chart-compact")!;
        const originalHeatmap = page.querySelector(".usage-heatmap")!;
        expect(originalChart).not.toBeNull();
        expect(originalHeatmap).not.toBeNull();
        expect(page.textContent).toContain("Old query row");
        expect(page.read().data.filterOptions?.agent).toEqual(["main"]);
        if (change === "creator") {
          page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(page.usageSelectedSessions).toEqual(["agent:main:old"]);
        }
        phase = "old";
        refreshButton(page).click();
        await page.updateComplete;
        phase = "new";
        if (change === "start date" || change === "end date") {
          const input =
            page.querySelectorAll<HTMLInputElement>("input.usage-date-input")[
              change === "start date" ? 0 : 1
            ]!;
          input.value = change === "start date" ? "2026-07-01" : "2026-08-08";
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (change === "scope") {
          [...page.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent?.trim() === "Current instance")!
            .click();
        } else if (change === "time zone") {
          const select = page.querySelector<HTMLSelectElement>("select.usage-select")!;
          select.value = "utc";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (change === "agent") {
          selection.setScope("writer");
        } else {
          const select = page.querySelector<HTMLSelectElement>(".usage-creator-filter")!;
          select.value = "profile:opaque-alex";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await page.updateComplete;
        expect(page.usageSelectedSessions).toEqual([]);
        expect(page.read().data.filterOptions).toBeUndefined();
        expect(originalChart.isConnected).toBe(false);
        expect(originalHeatmap.isConnected).toBe(false);
        expect(page.querySelector(".daily-chart-compact")).toBeNull();
        expect(page.querySelector(".usage-heatmap")).toBeNull();
        expect.soft(page.textContent).not.toContain("Old query row");
        expect
          .soft(
            [...page.querySelectorAll(".usage-metric-badge strong")].map(
              (node) => node.textContent,
            ),
          )
          .toEqual(["—", "—", "—"]);
        expect.soft(page.querySelector(".usage-empty-state")).toBeNull();
        expect(page.textContent).toContain("QA Provider Plan");
        expect(page.querySelector<HTMLInputElement>("input.usage-date-input")?.disabled).toBe(
          false,
        );

        oldReply.resolve(original);
        await vi.advanceTimersByTimeAsync(0);
        await page.updateComplete;
        expect.soft(page.textContent).not.toContain("Old query row");
        expect(page.read().data.filterOptions).toBeUndefined();
        await vi.advanceTimersByTimeAsync(400);
        const query = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1];
        expect(query).toMatchObject(
          change === "start date"
            ? { startDate: "2026-07-01" }
            : change === "end date"
              ? { endDate: "2026-08-08" }
              : change === "scope"
                ? { groupBy: "instance" }
                : change === "time zone"
                  ? { mode: "utc" }
                  : change === "agent"
                    ? { agentId: "writer" }
                    : { creatorKey: "profile:opaque-alex" },
        );
        newReply.resolve({
          ...original,
          startDate: String(query?.startDate),
          endDate: String(query?.endDate),
          sessions: [
            {
              key: "agent:writer:new",
              agentId: "writer",
              label: "New query row",
              usage: original.totals,
            },
          ],
        });
        await vi.advanceTimersByTimeAsync(0);
        await page.updateComplete;
        expect(page.textContent).toContain("New query row");
        expect(page.textContent).not.toContain("Old query row");
        expect(refreshButton(page).disabled).toBe(false);
        if (change === "creator") {
          const select = page.querySelector<HTMLSelectElement>(".usage-creator-filter")!;
          expect(select.value).toBe("profile:opaque-alex");
          expect(select.textContent).toContain("Alex Morgan");
          phase = "initial";
          select.value = "";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await vi.advanceTimersByTimeAsync(0);
          await page.updateComplete;
          expect(
            request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1],
          ).not.toHaveProperty("creatorKey");
          expect(page.textContent).toContain("Old query row");
          expect(page.textContent).not.toContain("New query row");
        }
      } finally {
        selection.dispose();
      }
    },
  );

  it.each(["same query", "dates"] as const)(
    "keeps overview data owned by its query after a failed %s request",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
      focusDocument();
      const snapshot = cacheSnapshot("fresh");
      let phase: "initial" | "failure" | "recovered" = "initial";
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "usage.status") {
          return {
            updatedAt: Date.now(),
            providers: [{ provider: "openai", displayName: "QA Provider Plan", windows: [] }],
          };
        }
        if (method === "sessions.usage" && phase === "failure") {
          throw new Error("QA usage temporarily unavailable");
        }
        const date = params?.startDate;
        const endDate = params?.endDate;
        assert(typeof date === "string" && typeof endDate === "string");
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            startDate: date,
            endDate,
            aggregates: {
              ...snapshot.result.aggregates,
              costDaily: [{ date, ...snapshot.result.totals }],
            },
            sessions: [
              {
                key: "agent:main:query-proof",
                agentId: "main",
                label: phase === "recovered" ? "Recovered query row" : "Original query row",
                usage: snapshot.result.totals,
              },
            ],
          };
        }
        throw new Error(`Unexpected Usage request: ${method}`);
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      expect(page.textContent).toContain("Original query row");
      // Provider plans load on the page after the route data applies.
      await vi.waitFor(() => expect(page.textContent).toContain("QA Provider Plan"));
      expect(page.querySelector(".cost-window--range")?.textContent).toContain("$1");
      const originalRange = page.querySelector(".cost-window-range")?.textContent?.trim();
      const originalValue = page
        .querySelector(".cost-window--range .cost-window__value")
        ?.textContent?.trim();
      expect(originalRange).toBeTruthy();
      expect(originalValue).toMatch(/^\$1(?:\.0+)?$/);

      phase = "failure";
      if (change === "dates") {
        const inputs = page.querySelectorAll<HTMLInputElement>("input.usage-date-input");
        for (const input of inputs) {
          input.value = "2026-07-01";
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        refreshButton(page).click();
      }
      await vi.advanceTimersByTimeAsync(400);
      await page.updateComplete;
      expect(page.querySelector(".usage-callout.danger")?.textContent).toContain(
        "QA usage temporarily unavailable",
      );
      expect(refreshButton(page).disabled).toBe(false);
      expect(page.textContent).toContain("QA Provider Plan");
      const query = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1];
      expect(query).toMatchObject(
        change === "dates"
          ? { startDate: "2026-07-01", endDate: "2026-07-01" }
          : { startDate: "2026-07-09", endDate: "2026-08-07" },
      );
      const failedRange = page.querySelector(".cost-window-range")?.textContent?.trim();
      const failedValue = page
        .querySelector(".cost-window--range .cost-window__value")
        ?.textContent?.trim();
      if (change === "same query") {
        expect(page.textContent).toContain("Original query row");
        expect(failedRange).toBe(originalRange);
        expect(failedValue).toBe(originalValue);
      } else if (failedValue && /\d/.test(failedValue)) {
        // Hiding unavailable totals is valid; retained numeric totals still belong to A.
        expect.soft(failedRange).toBe(originalRange);
        expect.soft(failedValue).toBe(originalValue);
      }

      phase = "recovered";
      refreshButton(page).click();
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(page.querySelector(".usage-callout.danger")).toBeNull();
      expect(page.textContent).toContain("Recovered query row");
      expect(page.querySelector(".cost-window--range")?.textContent).toContain("$1");
      expect(page.textContent).toContain("QA Provider Plan");
      if (change === "dates") {
        const recoveredRange = page.querySelector(".cost-window-range")?.textContent?.trim();
        expect(recoveredRange).toBeTruthy();
        expect(recoveredRange).not.toBe(originalRange);
      }
    },
  );
});
