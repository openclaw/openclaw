/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  createUsagePageFixture,
  loadUsagePage,
  focusDocument,
  preloadUsage,
  refreshButton,
  changeUsageControl,
  usageButton,
  usageCalls,
  textOf,
  settleUsageTimers,
  type TestUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

describe("UsagePage query ownership", () => {
  let baseResult: ReturnType<typeof cacheSnapshot>["result"];
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-08-07T12:00:00Z") });
    focusDocument();
    baseResult = cacheSnapshot("fresh").result;
  });

  type Control = HTMLInputElement | HTMLSelectElement;
  const rangeSnapshot = (page: TestUsagePage) => ({
    range: textOf(page, ".cost-window-range")?.trim(),
    value: textOf(page, ".cost-window--range .cost-window__value")?.trim(),
  });

  const providerPlan = () => ({
    updatedAt: Date.now(),
    providers: [{ provider: "openai", displayName: "QA Provider Plan", windows: [] }],
  });

  function usageRow(label: string, key = "agent:main:query-proof", agentId = "main") {
    return { ...baseResult, sessions: [{ key, agentId, label, usage: baseResult.totals }] };
  }

  it.each([
    ["startDate", "2026-07-01", '[aria-label="Start date"]'],
    ["endDate", "2026-08-08", '[aria-label="End date"]'],
    ["groupBy", "instance", null],
    ["mode", "utc", "select.usage-select"],
    ["agentId", "writer", null],
    ["creatorKey", "profile:opaque-alex", ".usage-creator-filter"],
  ] as const)(
    "rejects cached and late results after changing %s",
    async (change, value, selector) => {
      const original = {
        ...usageRow("Old query row", "agent:main:old"),
        creatorOptions: [
          { key: "profile:opaque-alex", actor: { type: "human" as const, label: "Alex Morgan" } },
        ],
      };
      const oldReply = deferred<typeof original>();
      const newReply = deferred<typeof original>();
      let reply: typeof original | Promise<typeof original> = original;
      const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        const replies: Record<string, unknown> = {
          "sessions.usage": reply,
          "sessions.usage.timeseries": { points: [] },
          "sessions.usage.logs": { logs: [] },
        };
        return replies[method] ?? providerPlan();
      });
      let selection: ReturnType<typeof createAgentSelectionCapability> | undefined;
      try {
        const { page, context } = await createUsagePageFixture(request, true, (fixture) => {
          selection = createAgentSelectionCapability(fixture.gateway, fixture.agents);
          fixture.agentSelection = selection;
        });
        await preloadUsage(page);
        expect(page.textContent).toContain("Old query row");
        if (change === "creatorKey") {
          page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(page.usageSelectedSessions).toEqual(["agent:main:old"]);
        }
        reply = oldReply.promise;
        refreshButton(page).click();
        await page.updateComplete;
        reply = newReply.promise;
        if (selector) {
          changeUsageControl(page.querySelector<Control>(selector)!, value);
        } else if (change === "groupBy") {
          usageButton(page, "Current instance").click();
        } else if (change === "agentId") {
          context.agentSelection.setScope(value);
        }
        await page.updateComplete;
        expect(page.usageSelectedSessions).toEqual([]);
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
        await settleUsageTimers(page);
        expect.soft(page.textContent).not.toContain("Old query row");
        await vi.advanceTimersByTimeAsync(400);
        const query = usageCalls(request).at(-1)?.[1];
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
          reply = original;
          changeUsageControl(select, "");
          await settleUsageTimers(page);
          expect(usageCalls(request).at(-1)?.[1]).not.toHaveProperty("creatorKey");
          expect(page.textContent).toContain("Old query row");
          expect(page.textContent).not.toContain("New query row");
        }
      } finally {
        selection?.dispose();
      }
    },
  );

  it.each([
    ["same query", { startDate: "2026-07-09", endDate: "2026-08-07" }],
    ["dates", { startDate: "2026-07-01", endDate: "2026-07-01" }],
  ] as const)(
    "keeps overview data owned by its query after a failed %s request",
    async (change, dates) => {
      let phase: "initial" | "failure" | "recovered" = "initial";
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "usage.status") {
          return providerPlan();
        }
        assert.equal(method, "sessions.usage", `Unexpected Usage request: ${method}`);
        if (phase === "failure") {
          throw new Error("QA usage temporarily unavailable");
        }
        const { startDate: date, endDate } = params ?? {};
        assert(typeof date === "string" && typeof endDate === "string");
        const label = phase === "recovered" ? "Recovered query row" : "Original query row";
        return {
          ...usageRow(label),
          startDate: date,
          endDate,
          aggregates: {
            ...baseResult.aggregates,
            costDaily: [{ date, ...baseResult.totals }],
          },
        };
      });
      const { page } = await loadUsagePage(request);
      expect(page.textContent).toContain("Original query row");
      // Provider plans load on the page after the route data applies.
      await vi.waitFor(() => expect(page.textContent).toContain("QA Provider Plan"));
      const original = rangeSnapshot(page);
      expect(original.range).toBeTruthy();
      expect(original.value).toMatch(/^\$1(?:\.0+)?$/);

      phase = "failure";
      if (change === "dates") {
        const inputs = page.querySelectorAll<HTMLInputElement>("input.usage-date-input");
        for (const input of inputs) {
          changeUsageControl(input, "2026-07-01");
        }
      } else {
        refreshButton(page).click();
      }
      await settleUsageTimers(page, 400);
      expect(textOf(page, ".usage-callout.danger")).toContain("QA usage temporarily unavailable");
      expect(refreshButton(page).disabled).toBe(false);
      expect(page.textContent).toContain("QA Provider Plan");
      expect(usageCalls(request).at(-1)?.[1]).toMatchObject(dates);
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
      expect(textOf(page, ".cost-window--range")).toContain("$1");
      expect(page.textContent).toContain("QA Provider Plan");
      if (change === "dates") {
        const recoveredRange = textOf(page, ".cost-window-range")?.trim();
        expect(recoveredRange).toBeTruthy();
        expect(recoveredRange).not.toBe(original.range);
      }
    },
  );
});
