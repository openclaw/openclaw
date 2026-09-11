/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  contextWeight,
  createPage,
  deferred,
  preloadUsage,
  refreshButton,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

function usagePoints(timestamp: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: timestamp + index * 1_000,
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    cost: 0,
    cumulativeTokens: (index + 1) * 100,
    cumulativeCost: 0,
  }));
}

function dragTimelineRange(page: HTMLElement) {
  const svg = page.querySelector<SVGSVGElement>(".timeseries-svg")!;
  const handle = page.querySelector<HTMLElement>(".chart-handle-right")!;
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 118));
  handle.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      clientX: Number.parseFloat(handle.style.left) * 4,
    }),
  );
  const move = () => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 213 }));
  move();
  return { move, end: () => document.dispatchEvent(new MouseEvent("mouseup")) };
}

describe("UsagePage detail identity", () => {
  it.each([
    { refresh: "automatic", points: 1, activeDrag: false },
    { refresh: "manual", points: 2, activeDrag: false },
    { refresh: "automatic", points: 1, activeDrag: true },
    { refresh: "manual", points: 2, activeDrag: true },
  ])(
    "retires a selected range during $refresh instance replacement with $points points (active drag: $activeDrag)",
    async ({ refresh, points, activeDrag }) => {
      const snapshot = cacheSnapshot("sessions", "fresh");
      const timestamp = new Date().setHours(12, 0, 0, 0);
      let sessionId = "original-instance";
      let series = usagePoints(timestamp, 3);
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            sessions: [
              { key: "global", agentId: "main", sessionId, usage: snapshot.result.totals },
            ],
          };
        }
        if (method === "sessions.usage.timeseries") {
          return { sessionId, points: series };
        }
        if (method === "sessions.usage.logs") {
          return {
            logs: series.map((point, index) => ({
              timestamp: point.timestamp,
              role: "assistant",
              content: `${sessionId} reply ${index + 1}`,
            })),
          };
        }
        return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.waitFor(() => expect(page.querySelectorAll(".session-log-entry")).toHaveLength(3));
      const drag = dragTimelineRange(page);
      try {
        await page.updateComplete;
        expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
        if (!activeDrag) {
          drag.end();
        }
        sessionId = "replacement-instance";
        series = usagePoints(timestamp + 60_000, points);
        if (refresh === "manual") {
          refreshButton(page).click();
        } else {
          await page.loadUsage();
        }
        await vi.waitFor(() => expect(page.details.timeSeries.data?.sessionId).toBe(sessionId));
        if (activeDrag) {
          drag.move();
        }
        await page.updateComplete;
        expect.soft(page.usageSelectedSessions).toEqual(["global"]);
        expect
          .soft(
            [...page.querySelectorAll(".session-log-content")].map((entry) => entry.textContent),
          )
          .toEqual(series.map((_, index) => `${sessionId} reply ${index + 1}`));
        expect.soft(page.querySelector(".timeseries-summary__range")).toBeNull();
        expect
          .soft(page.querySelector(".session-logs-header-count")?.textContent)
          .not.toContain("timeline filtered");
      } finally {
        drag.end();
      }
    },
  );

  it.each([
    { replacement: "owner", refresh: "manual" },
    { replacement: "owner", refresh: "automatic" },
    { replacement: "instance", refresh: "manual" },
    { replacement: "instance", refresh: "automatic" },
  ])(
    "retires old-$replacement details and pending recovery during $refresh overview refresh",
    async ({ replacement, refresh }) => {
      const snapshot = cacheSnapshot("sessions", "fresh");
      const retired = deferred<SessionUsageTimeSeries>();
      let agentId = "main";
      let sessionId = "original-instance";
      let holdOriginal = false;
      let replaced = false;
      const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            sessions: [
              {
                key: "global",
                agentId,
                sessionId,
                label: replaced ? "Replacement session" : "Original session",
                usage: snapshot.result.totals,
              },
            ],
          };
        }
        if (method === "sessions.usage.logs" || method === "sessions.usage.timeseries") {
          if (replaced) {
            throw new Error("Replacement details unavailable");
          }
          if (holdOriginal) {
            return retired.promise;
          }
          return method === "sessions.usage.logs"
            ? { logs: [{ timestamp: 1, role: "user", content: "Original turn" }] }
            : { sessionId: "original-instance", points: [] };
        }
        return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, true, context);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.waitFor(() => expect(page.textContent).toContain("Original turn"));
      expect(page.details.timeSeries.data?.sessionId).toBe("original-instance");

      holdOriginal = true;
      const oldLoad = page.details.timeSeries.load("global");
      context.setGatewaySnapshot({ suspensionPhase: "draining" });
      context.setGatewaySnapshot({ suspensionPhase: "accepting" });
      replaced = true;
      if (replacement === "owner") {
        agentId = "opus";
      } else {
        sessionId = "replacement-instance";
      }
      const beforeRefresh = request.mock.calls.length;
      if (refresh === "manual") {
        refreshButton(page).click();
      } else {
        await page.loadUsage();
      }
      await vi.waitFor(() =>
        expect(page.querySelector(".session-bar-selection")?.textContent).toContain(
          "Replacement session",
        ),
      );
      expect.soft(page.usageSelectedSessions).toEqual(["global"]);
      expect.soft(page.details.timeSeries.data).toBeNull();
      expect.soft(page.details.sessionLogs.data).toBeNull();
      retired.resolve({ sessionId: "retired-instance", points: [] });
      await oldLoad;
      await vi.waitFor(() => {
        expect(page.details.timeSeries.loading).toBe(false);
        expect(page.details.sessionLogs.loading).toBe(false);
      });
      expect.soft(page.details.timeSeries.data).toBeNull();
      expect.soft(page.details.sessionLogs.data).toBeNull();
      expect.soft(page.details.timeSeries.status.error).toBe("Replacement details unavailable");
      expect.soft(page.details.sessionLogs.status.error).toBe("Replacement details unavailable");
      for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
        const requests = request.mock.calls
          .slice(beforeRefresh)
          .filter(([name]) => name === method);
        expect.soft(requests, method).toHaveLength(1);
        expect.soft(requests[0]?.[1], method).toEqual({
          key: "global",
          agentId,
          ...(method === "sessions.usage.logs" ? { limit: 1000 } : {}),
        });
      }
    },
  );

  it.each([
    { sessionId: undefined, refresh: "automatic" },
    { sessionId: "stable-instance", refresh: "automatic" },
    { sessionId: undefined, refresh: "manual" },
    { sessionId: "stable-instance", refresh: "manual" },
  ])(
    "retains healthy details and range during $refresh refresh of optional instance $sessionId",
    async ({ sessionId, refresh }) => {
      const snapshot = cacheSnapshot("sessions", "fresh");
      const points = usagePoints(new Date().setHours(12, 0, 0, 0), 3);
      let label = "Original summary";
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            sessions: [
              { key: "global", agentId: "main", sessionId, label, usage: snapshot.result.totals },
            ],
          };
        }
        if (method === "sessions.usage.logs") {
          return {
            logs: points.map((point) => ({
              timestamp: point.timestamp,
              role: "user",
              content: "Retained turn",
            })),
          };
        }
        if (method === "sessions.usage.timeseries") {
          return { sessionId, points };
        }
        return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.waitFor(() => expect(page.textContent).toContain("Retained turn"));
      dragTimelineRange(page).end();
      await page.updateComplete;
      expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
      const range = page.querySelector(".timeseries-summary__range")?.textContent;
      const timeSeries = page.details.timeSeries.data;
      const logs = page.details.sessionLogs.data;
      label = "Refreshed summary";
      if (refresh === "manual") {
        refreshButton(page).click();
      } else {
        await page.loadUsage();
      }
      await vi.waitFor(() =>
        expect(page.querySelector(".session-bar-selection")?.textContent).toContain(label),
      );
      await vi.waitFor(() => expect(page.details.timeSeries.loading).toBe(false));
      await page.updateComplete;
      expect(page.querySelector(".session-bar-selection")?.textContent).toContain(label);
      expect(page.usageSelectedSessions).toEqual(["global"]);
      expect(page.details.timeSeries.data).toEqual(timeSeries);
      expect(page.details.sessionLogs.data).toEqual(logs);
      expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
      expect(page.querySelector(".timeseries-summary__range")?.textContent).toBe(range);
      for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
        expect(
          request.mock.calls.filter(([name]) => name === method),
          method,
        ).toHaveLength(refresh === "manual" ? 2 : 1);
      }
    },
  );
  it.each([
    { captured: "selected-instance", returned: "retired-instance", conflict: true },
    { captured: "selected-instance", returned: "selected-instance", conflict: false },
    { captured: "selected-instance", returned: undefined, conflict: false },
    { captured: undefined, returned: "selected-instance", conflict: false },
  ])(
    "binds context response $returned to optional captured instance $captured",
    async ({ captured, returned, conflict }) => {
      const snapshot = cacheSnapshot("sessions", "fresh");
      let returnedId = returned;
      let report = "Initial context";
      const session = {
        key: "global",
        agentId: "opus",
        sessionId: captured,
        hasContextWeight: true,
        usage: snapshot.result.totals,
      };
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            sessions: [
              params?.key
                ? { ...session, sessionId: returnedId, contextWeight: contextWeight(report) }
                : session,
            ],
          };
        }
        return method === "usage.cost"
          ? snapshot.costSummary
          : { providers: [], logs: [], points: [] };
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.waitFor(() => expect(page.details.contextWeight.loading).toBe(false));
      await page.updateComplete;
      if (conflict) {
        expect.soft(page.details.contextWeight.data).toBeNull();
        expect
          .soft(page.details.contextWeight.status.error)
          .toBe("These context details are out of date. Refresh usage and try again.");
        expect
          .soft(page.querySelector(".context-details-panel")?.textContent)
          .not.toContain(report);
      } else {
        expect(page.details.contextWeight.data).toEqual(contextWeight(report));
        expect(page.details.contextWeight.status.error).toBeNull();
      }
      returnedId = captured;
      report = "Recovered context";
      refreshButton(page).click();
      await vi.waitFor(() =>
        expect(page.details.contextWeight.data).toEqual(contextWeight(report)),
      );
      expect(page.details.contextWeight.status.error).toBeNull();
      expect(page.usageSelectedSessions).toEqual(["global"]);
      for (const [method, params] of request.mock.calls) {
        if (method === "sessions.usage" && params?.key) {
          expect(params).not.toHaveProperty("sessionId");
        }
      }
    },
  );
});
