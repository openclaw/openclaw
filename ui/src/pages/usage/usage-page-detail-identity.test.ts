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

describe("UsagePage detail identity", () => {
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

  it.each([undefined, "stable-instance"])(
    "retains healthy details during automatic refresh of the same optional instance %s",
    async (sessionId) => {
      const snapshot = cacheSnapshot("sessions", "fresh");
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
          return { logs: [{ timestamp: 1, role: "user", content: "Retained turn" }] };
        }
        if (method === "sessions.usage.timeseries") {
          return { sessionId, points: [] };
        }
        return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.waitFor(() => expect(page.textContent).toContain("Retained turn"));
      const timeSeries = page.details.timeSeries.data;
      const logs = page.details.sessionLogs.data;
      label = "Refreshed summary";
      await page.loadUsage();
      await page.updateComplete;
      expect(page.querySelector(".session-bar-selection")?.textContent).toContain(label);
      expect(page.usageSelectedSessions).toEqual(["global"]);
      expect(page.details.timeSeries.data).toEqual(timeSeries);
      expect(page.details.sessionLogs.data).toEqual(logs);
      for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
        expect(
          request.mock.calls.filter(([name]) => name === method),
          method,
        ).toHaveLength(1);
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
