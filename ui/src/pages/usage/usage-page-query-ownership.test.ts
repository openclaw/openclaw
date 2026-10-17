/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import {
  createUsagePageFixture,
  settleUsageTimers,
  textOf,
  cacheSnapshot,
  cleanupUsagePageTest,
  focusDocument,
  preloadUsage,
  refreshButton,
  type TestUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
let baseResult: ReturnType<typeof cacheSnapshot>["result"];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
  focusDocument();
  baseResult = cacheSnapshot("fresh").result;
});

function changeControl(control: HTMLInputElement | HTMLSelectElement, value: string) {
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function rangeSnapshot(page: TestUsagePage) {
  return {
    range: textOf(page, ".cost-window-range-label")?.trim(),
    value: textOf(page, ".cost-window-card--range .cost-window-card__value")?.trim(),
  };
}

const providerPlan = () => ({
  updatedAt: Date.now(),
  providers: [{ provider: "openai", displayName: "QA Provider Plan", windows: [] }],
});

function usageRow(label: string, key = "agent:main:query-proof", agentId = "main") {
  return { ...baseResult, sessions: [{ key, agentId, label, usage: baseResult.totals }] };
}

it.each([
  ["startDate", "2026-07-01", "input.usage-date-input", 0],
  ["endDate", "2026-08-08", "input.usage-date-input", 1],
  ["groupBy", "instance", null, 0],
  ["mode", "utc", "select.usage-select", 0],
  ["agentId", "writer", null, 0],
  ["creatorKey", "profile:opaque-alex", ".usage-creator-filter", 0],
] as const)(
  "does not attribute cached or late results to a changed %s",
  async (change, value, selector, index) => {
    const original = {
      ...usageRow("Old query row", "agent:main:old"),
      creatorOptions: [
        { key: "profile:opaque-alex", actor: { type: "human" as const, label: "Alex Morgan" } },
      ],
    };
    const oldReply = deferred<typeof original>();
    const newReply = deferred<typeof original>();
    let phase: "initial" | "old" | "new" = "initial";
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      const replies: Record<string, unknown> = {
        "sessions.usage": { initial: original, old: oldReply.promise, new: newReply.promise }[
          phase
        ],
        "sessions.usage.timeseries": { points: [] },
        "sessions.usage.logs": { logs: [] },
      };
      return replies[method] ?? providerPlan();
    });
    const lastQuery = () =>
      request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1];
    let disposeSelection = () => {};
    try {
      const { page, context } = await createUsagePageFixture(request, true, (fixture) => {
        const selection = createAgentSelectionCapability(
          {
            connection: { gatewayUrl: "ws://qa.invalid" },
            snapshot: { assistantAgentId: null },
            subscribe: () => () => {},
          },
          fixture.agents,
        );
        fixture.agentSelection = selection;
        disposeSelection = () => selection.dispose();
      });
      await preloadUsage(page);
      expect(page.textContent).toContain("Old query row");
      if (change === "creatorKey") {
        page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(page.usageSelectedSessions).toEqual(["agent:main:old"]);
      }
      phase = "old";
      refreshButton(page).click();
      await page.updateComplete;
      phase = "new";
      if (selector) {
        changeControl(
          page.querySelectorAll<HTMLInputElement | HTMLSelectElement>(selector)[index]!,
          value,
        );
      } else if (change === "groupBy") {
        [...page.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Current instance")!
          .click();
      } else if (change === "agentId") {
        context.agentSelection.setScope(value);
      }
      await page.updateComplete;
      expect(page.usageSelectedSessions).toEqual([]);
      expect.soft(page.textContent).not.toContain("Old query row");
      expect.soft(page.querySelector(".usage-metric-badge")).toBeNull();
      expect.soft(page.querySelector(".usage-empty-state")).toBeNull();
      expect(page.textContent).toContain("QA Provider Plan");
      expect(page.querySelector<HTMLInputElement>("input.usage-date-input")?.disabled).toBe(false);

      oldReply.resolve(original);
      await settleUsageTimers(page);
      expect.soft(page.textContent).not.toContain("Old query row");
      await vi.advanceTimersByTimeAsync(400);
      const query = lastQuery();
      expect(query).toMatchObject({ [change]: value });
      newReply.resolve({
        ...original,
        startDate: String(query?.startDate),
        endDate: String(query?.endDate),
        sessions: usageRow("New query row", "agent:writer:new", "writer").sessions,
      });
      await settleUsageTimers(page);
      expect(page.textContent).toContain("New query row");
      expect(page.textContent).not.toContain("Old query row");
      expect(refreshButton(page).disabled).toBe(false);
      if (change === "creatorKey") {
        const select = page.querySelector<HTMLSelectElement>(".usage-creator-filter")!;
        expect(select.value).toBe("profile:opaque-alex");
        expect(select.textContent).toContain("Alex Morgan");
        phase = "initial";
        changeControl(select, "");
        await settleUsageTimers(page);
        expect(lastQuery()).not.toHaveProperty("creatorKey");
        expect(page.textContent).toContain("Old query row");
        expect(page.textContent).not.toContain("New query row");
      }
    } finally {
      disposeSelection();
    }
  },
);

it.each(["same query", "dates"] as const)(
  "keeps overview data owned by its query after a failed %s request",
  async (change) => {
    let phase: "initial" | "failure" | "recovered" = "initial";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "usage.status") {
        return providerPlan();
      }
      if (method === "sessions.usage" && phase === "failure") {
        throw new Error("QA usage temporarily unavailable");
      }
      const { startDate: date, endDate } = params ?? {};
      assert(typeof date === "string" && typeof endDate === "string");
      if (method === "sessions.usage") {
        const result = usageRow(
          phase === "recovered" ? "Recovered query row" : "Original query row",
        );
        return {
          ...result,
          startDate: date,
          endDate,
          aggregates: {
            ...result.aggregates,
            costDaily: [{ date, ...result.totals }],
          },
        };
      }
      throw new Error(`Unexpected Usage request: ${method}`);
    });
    const { page } = await createUsagePageFixture(request);
    await preloadUsage(page);
    expect(page.textContent).toContain("Original query row");
    expect(page.textContent).toContain("QA Provider Plan");
    expect(textOf(page, ".cost-window-card--range")).toContain("$1");
    const original = rangeSnapshot(page);
    expect(original.range).toBeTruthy();
    expect(original.value).toMatch(/^\$1(?:\.0+)?$/);

    phase = "failure";
    if (change === "dates") {
      const inputs = page.querySelectorAll<HTMLInputElement>("input.usage-date-input");
      for (const input of inputs) {
        changeControl(input, "2026-07-01");
      }
    } else {
      refreshButton(page).click();
    }
    await settleUsageTimers(page, 400);
    expect(textOf(page, ".usage-callout.danger")).toContain("QA usage temporarily unavailable");
    expect(refreshButton(page).disabled).toBe(false);
    expect(page.textContent).toContain("QA Provider Plan");
    const query = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1];
    expect(query).toMatchObject(
      change === "dates"
        ? { startDate: "2026-07-01", endDate: "2026-07-01" }
        : { startDate: "2026-07-09", endDate: "2026-08-07" },
    );
    const failed = rangeSnapshot(page);
    if (change === "same query") {
      expect(page.textContent).toContain("Original query row");
      expect(failed).toEqual(original);
    } else if (failed.value && /\d/.test(failed.value)) {
      // Hiding unavailable totals is valid; retained numeric totals still belong to A.
      expect.soft(failed).toEqual(original);
    }

    phase = "recovered";
    refreshButton(page).click();
    await settleUsageTimers(page);
    expect(page.querySelector(".usage-callout.danger")).toBeNull();
    expect(page.textContent).toContain("Recovered query row");
    expect(textOf(page, ".cost-window-card--range")).toContain("$1");
    expect(page.textContent).toContain("QA Provider Plan");
    if (change === "dates") {
      const recoveredRange = textOf(page, ".cost-window-range-label")?.trim();
      expect(recoveredRange).toBeTruthy();
      expect(recoveredRange).not.toBe(original.range);
    }
  },
);
