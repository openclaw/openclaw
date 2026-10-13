/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
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
  it.each(["start date", "end date", "scope", "time zone", "agent", "creator"] as const)(
    "does not attribute cached or late results to a changed %s",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
      focusDocument();
      const snapshot = cacheSnapshot("fresh");
      const original = {
        ...snapshot.result,
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
        expect(page.textContent).toContain("Old query row");
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
        expect.soft(page.textContent).not.toContain("Old query row");
        expect.soft(page.querySelector(".usage-metric-badge")).toBeNull();
        expect.soft(page.querySelector(".usage-empty-state")).toBeNull();
        expect(page.textContent).toContain("QA Provider Plan");
        expect(page.querySelector<HTMLInputElement>("input.usage-date-input")?.disabled).toBe(
          false,
        );

        oldReply.resolve(original);
        await vi.advanceTimersByTimeAsync(0);
        await page.updateComplete;
        expect.soft(page.textContent).not.toContain("Old query row");
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
      expect(page.textContent).toContain("QA Provider Plan");
      expect(page.querySelector(".cost-window-card--range")?.textContent).toContain("$1");
      const originalRange = page.querySelector(".cost-window-range-label")?.textContent?.trim();
      const originalValue = page
        .querySelector(".cost-window-card--range .cost-window-card__value")
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
      const failedRange = page.querySelector(".cost-window-range-label")?.textContent?.trim();
      const failedValue = page
        .querySelector(".cost-window-card--range .cost-window-card__value")
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
      expect(page.querySelector(".cost-window-card--range")?.textContent).toContain("$1");
      expect(page.textContent).toContain("QA Provider Plan");
      if (change === "dates") {
        const recoveredRange = page.querySelector(".cost-window-range-label")?.textContent?.trim();
        expect(recoveredRange).toBeTruthy();
        expect(recoveredRange).not.toBe(originalRange);
      }
    },
  );
});
