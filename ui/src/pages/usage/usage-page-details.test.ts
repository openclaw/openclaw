/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { SessionsUsageResult } from "../../api/types.ts";
import * as downloads from "../../lib/download.ts";
import { suspendingGatewayError as suspensionError } from "../../test-helpers/gateway-errors.test-support.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { selectUsageExport } from "./export-menu.test-support.ts";
import type { UsageSessionEntry, UsageRouteData } from "./types.ts";
import {
  createUsagePageFixture,
  loadUsagePage,
  usagePoints,
  usageCalls,
  textOf,
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  createPendingUsageRouteData,
  focusDocument,
  refreshButton,
  showRecentSessions,
  queryUsagePage,
  selectUsageSession,
  settleUsagePage,
  usageButton,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

function detailCalls<T extends readonly unknown[]>(request: { mock: { calls: T[] } }) {
  return request.mock.calls.filter(
    ([method]) => method === "sessions.usage.timeseries" || method === "sessions.usage.logs",
  );
}

describe("UsagePage detail requests", () => {
  it("retains accepted details while refreshes wait, fail, and retry", async () => {
    const snapshot = cacheSnapshot("fresh");
    const session = {
      key: "agent:main:retained-details",
      label: "Retained details",
      agentId: "main",
      usage: snapshot.result.totals,
      contextWeight: contextWeight("accepted"),
    };
    const result = { ...snapshot.result, sessions: [session] };
    const pending = {
      context: deferred<unknown>(),
      timeline: deferred<unknown>(),
      logs: deferred<unknown>(),
    };
    let hold = false;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return hold && params?.key ? pending.context.promise : result;
      }
      if (method === "sessions.usage.timeseries") {
        return hold ? pending.timeline.promise : { points: usagePoints(Date.now(), 2, 0.1) };
      }
      if (method === "sessions.usage.logs") {
        return hold
          ? pending.logs.promise
          : {
              logs: [{ timestamp: 1, role: "user", content: "Accepted conversation" }],
            };
      }
      return { providers: [] };
    });
    const { page } = await loadUsagePage(request);
    selectUsageSession(page);
    await waitForFast(() => expect(page.textContent).toContain("Accepted conversation"));
    const chart = page.querySelector(".timeseries-svg");
    const log = page.querySelector(".session-log-content");
    expect(chart).not.toBeNull();

    hold = true;
    refreshButton(page).click();
    await waitForFast(() => expect(usageCalls(request, "sessions.usage.logs")).toHaveLength(2));
    await page.updateComplete;
    expect(page.querySelector(".timeseries-svg")).toBe(chart);
    expect(page.querySelector(".session-log-content")).toBe(log);
    expect(page.textContent).toContain("accepted");

    for (const read of Object.values(pending)) {
      read.reject(new Error("Refresh unavailable"));
    }
    await waitForFast(() => {
      for (const kind of ["timeline", "conversation", "context"]) {
        expect(textOf(page, `.usage-detail-error--${kind}`)).toContain("Refresh unavailable");
      }
    });
    expect(page.querySelector(".timeseries-svg")).toBe(chart);
    expect(page.querySelector(".session-log-content")).toBe(log);

    hold = false;
    refreshButton(page).click();
    await waitForFast(() => expect(page.querySelector(".usage-detail-error")).toBeNull());
    expect(page.textContent).toContain("Accepted conversation");
  });

  it("keeps selected comparisons across pages and refreshes them with their overview", async () => {
    const snapshot = cacheSnapshot("fresh");
    let revision = snapshot.result.updatedAt;
    let sessions = Array.from({ length: 53 }, (_, index) => ({
      key: `agent:main:comparison-${index}`,
      label: `Comparison ${index + 1}`,
      agentId: "main",
      sessionId: `comparison-${index}`,
      updatedAt: 100 - index,
      usage: { ...snapshot.result.totals, totalTokens: 100 },
    }));
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
      method === "sessions.usage"
        ? {
            ...snapshot.result,
            updatedAt: revision,
            sessions: params?.key
              ? sessions.filter((session) => session.key === params.key)
              : sessions,
          }
        : { providers: [], points: [], logs: [] },
    );
    const { page } = await loadUsagePage(request);
    await showRecentSessions(page);
    const settle = () => settleUsagePage(page);
    const changePage = async (label: string) => {
      usageButton(page, label, ".data-table-pagination button").click();
      await settle();
    };
    const compare = (label: string, shiftKey = false) =>
      page
        .querySelector<HTMLButtonElement>(
          `.session-bars:not(.session-bars--selected) .session-bar-selection[aria-label="${label}"]`,
        )!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
    const comparisons = () =>
      [...page.querySelectorAll(".session-bars--selected .session-bar-title")].map(
        (row) => row.textContent,
      );

    await changePage("Next");
    compare("Comparison 51");
    await settle();
    expect(textOf(page, ".session-bars .session-bar-title")).toBe("Comparison 51");
    compare("Comparison 53", true);
    await settle();
    expect(comparisons()).toEqual(["Comparison 51", "Comparison 52", "Comparison 53"]);
    await changePage("Previous");
    expect(textOf(page, ".session-bars .session-bar-title")).toBe("Comparison 1");
    expect(comparisons()).toEqual(["Comparison 51", "Comparison 52", "Comparison 53"]);

    revision++;
    sessions = sessions.map((session, index) =>
      index === 50 ? { ...session, usage: { ...session.usage, totalTokens: 350 } } : session,
    );
    refreshButton(page).click();
    await settle();
    expect(textOf(page, ".session-bars--selected .session-bar-value")).toBe("350");

    revision++;
    sessions = sessions.filter((session) => session.label !== "Comparison 52");
    refreshButton(page).click();
    await settle();
    expect(comparisons()).toEqual(["Comparison 51", "Comparison 53"]);
    expect(page.usageSelectedSessions).toHaveLength(3);

    page
      .querySelector<HTMLButtonElement>(
        '.session-bars--selected .session-bar-selection[aria-label="Comparison 53"]',
      )!
      .click();
    await settle();
    expect(textOf(page, ".session-detail-title")).toContain("Comparison 53");

    await queryUsagePage(page, "label:missing");
    expect(page.querySelector(".session-bar-row, .sessions-selected-group")).toBeNull();
    usageButton(page, "Clear Selection", ".sessions-card button").click();
    await settle();
    expect(page.usageSelectedSessions).toEqual([]);
  });

  it.each([
    { key: "global", agentId: "opus", needsOwnerHint: true },
    { key: "agent:openclaw:usage", agentId: "openclaw", needsOwnerHint: false },
  ])(
    "routes every selected $key detail through its listed agent",
    async ({ key, agentId, needsOwnerHint }) => {
      const snapshot = cacheSnapshot("fresh");
      const session = {
        key,
        agentId,
        sessionId: `${agentId}-instance`,
        hasContextWeight: true,
        usage: snapshot.result.totals,
      };
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "sessions.usage") {
          return {
            ...snapshot.result,
            sessions: [
              { ...session, ...(params?.key ? { contextWeight: contextWeight(agentId) } : {}) },
            ],
          };
        }
        if (method === "sessions.usage.logs") {
          return { logs: [{ timestamp: 1, role: "user", content: `${agentId} turn` }] };
        }
        return { providers: [], points: [] };
      });
      const { page } = await loadUsagePage(request);
      selectUsageSession(page);
      await waitForFast(() => expect(page.textContent).toContain(`${agentId} turn`));

      for (const method of ["sessions.usage", "sessions.usage.timeseries", "sessions.usage.logs"]) {
        const detail = request.mock.calls.find(([name, params]) => name === method && params?.key);
        expect.soft(detail?.[1], method).toMatchObject({ key });
        expect.soft(detail?.[1], method).not.toHaveProperty("sessionId");
        if (needsOwnerHint) {
          expect.soft(detail?.[1], method).toHaveProperty("agentId", agentId);
        } else {
          expect.soft(detail?.[1], method).not.toHaveProperty("agentId");
        }
      }
    },
  );

  it("retains the second row identity when selecting again before the overview settles", async () => {
    const snapshot = cacheSnapshot("fresh");
    const sessions = ["First", "Second"].map((label) => ({
      key: `agent:main:${label}`,
      label,
      agentId: "main",
      sessionId: `${label}-live`,
      usage: { ...snapshot.result.totals, firstActivity: 1 },
      hasContextWeight: true,
    }));
    const pending = new Promise<never>(() => {});
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method !== "sessions.usage") {
        return { providers: [], points: [], logs: [] };
      }
      if (params?.key) {
        const row = sessions.find((session) => session.key === params.key)!;
        return {
          ...snapshot.result,
          sessions: [
            {
              ...row,
              sessionId: row.label === "Second" ? "retired" : row.sessionId,
              contextWeight: contextWeight("Wrong identity"),
            },
          ],
        };
      }
      return params?.selectedSessions ? pending : { ...snapshot.result, sessions };
    });
    const { page } = await loadUsagePage(request);
    page.querySelector<HTMLButtonElement>('.session-bar-selection[aria-label="First"]')!.click();
    await page.updateComplete;
    expect(page.usageLoading).toBe(true);
    page.querySelector<HTMLButtonElement>('.session-bar-selection[aria-label="Second"]')!.click();
    await waitForFast(() =>
      expect(page.read().detail.context.status.error).toContain("out of date"),
    );
    expect(page.usageSelectedSessions).toEqual(["agent:main:Second"]);
    expect(textOf(page, ".session-detail-title")).toContain("Second");
    expect(page.textContent).not.toContain("Wrong identity");
  });

  it("keeps unavailable timeline and conversation details pending and refreshes them when admission reopens", async () => {
    const snapshot = cacheSnapshot("fresh");
    const session = {
      key: "agent:main:detail",
      label: "Detail session",
      usage: snapshot.result.totals,
    };
    let unavailable = true;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return { ...snapshot.result, sessions: [session] };
      }
      if (method === "usage.status") {
        return { providers: [] };
      }
      if (unavailable) {
        throw suspensionError("Gateway is suspending");
      }
      return method === "sessions.usage.logs"
        ? { logs: [{ timestamp: Date.now(), role: "user", content: "Recovered conversation" }] }
        : {
            points: usagePoints(Date.now(), 2, 0.1).map((point, offset) =>
              Object.assign(point, {
                timestamp: Date.now() + offset,
                cumulativeTokens: 100,
                cumulativeCost: 0.1,
              }),
            ),
          };
    });
    const { context, page } = await loadUsagePage(request);
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    selectUsageSession(page);
    await waitForFast(() =>
      expect(page.read().detail).toMatchObject({
        timeSeriesStatus: { awaitingGateway: true },
        sessionLogsStatus: { awaitingGateway: true },
      }),
    );
    await page.updateComplete;
    expect(
      page.querySelector(".usage-detail-error--timeline, .usage-detail-error--conversation"),
    ).toBeNull();
    expect(textOf(page, ".session-logs-compact")).toContain("Loading");

    unavailable = false;
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    await waitForFast(() => expect(page.textContent).toContain("Recovered conversation"));
    expect(page.querySelector(".timeseries-svg")).not.toBeNull();
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
    }
  });

  it.each(["admission", "reconnect"] as const)(
    "recovers pending details after %s and fences late failures",
    async (recovery) => {
      const pending = deferred<never>();
      let recovered = false;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.usage") {
          return cacheSnapshot("fresh").result;
        }
        if (method === "usage.status") {
          return { providers: [] };
        }
        if (!recovered) {
          return pending.promise;
        }
        return method === "sessions.usage.logs"
          ? { logs: [{ timestamp: 1, role: "user", content: "Recovered" }] }
          : { points: [{ timestamp: 1 }] };
      });
      const { context, page } = await createUsagePageFixture(request, false);
      page
        .read()
        .callbacks.details.onSelectSession("agent:main:detail", false, ["agent:main:detail"]);
      if (recovery === "admission") {
        for (let attempt = 0; attempt < 2; attempt++) {
          context.setGatewaySnapshot({ suspensionPhase: "draining" });
          context.setGatewaySnapshot({ suspensionPhase: "accepting" });
        }
        expect(detailCalls(request)).toHaveLength(2);
        recovered = true;
        pending.reject(suspensionError("Gateway was suspending"));
      } else {
        context.setGatewaySnapshot({ phase: "stopped" });
        recovered = true;
        context.setGatewaySnapshot({ phase: "connected" });
        await waitForFast(() =>
          expect(page.read().detail.sessionLogs?.[0]?.content).toBe("Recovered"),
        );
        pending.reject(new Error("gateway closed (1006): disconnected"));
      }
      await pending.promise.catch(() => {});
      await waitForFast(() =>
        expect(page.read().detail.sessionLogs?.[0]?.content).toBe("Recovered"),
      );
      expect(page.read().detail.timeSeries?.points).toHaveLength(1);
      expect(page.read().detail).toMatchObject({
        timeSeriesStatus: { error: null },
        sessionLogsStatus: { error: null },
      });
      expect(detailCalls(request)).toHaveLength(4);
    },
  );

  it("does not transfer queued detail recovery to a replacement selection", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    const request = vi.fn((method: string, params: { key: string }) => {
      if (method === "sessions.usage") {
        return Promise.resolve(cacheSnapshot("fresh").result);
      }
      if (method === "usage.status") {
        return Promise.resolve({ providers: [] });
      }
      return params.key === "agent:main:first" ? first.promise : second.promise;
    });
    const { context, page } = await createUsagePageFixture(request, false);
    page
      .read()
      .callbacks.details.onSelectSession("agent:main:first", false, [
        "agent:main:first",
        "agent:main:second",
      ]);
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });

    page
      .read()
      .callbacks.details.onSelectSession("agent:main:second", false, [
        "agent:main:first",
        "agent:main:second",
      ]);
    second.reject(new Error("Selected timeline unavailable"));
    await page.read().detail.timeSeriesRead;
    first.reject(new Error("Retired timeline unavailable"));
    await first.promise.catch(() => {});
    expect(usageCalls(request, "sessions.usage.timeseries")).toHaveLength(2);
    expect(page.read().detail).toMatchObject({
      timeSeries: null,
      timeSeriesStatus: { error: "Selected timeline unavailable" },
    });
  });

  it("loads context only for the selected session and fences superseded replies through automatic recovery", async () => {
    const snapshot = cacheSnapshot("fresh");
    const keys = ["agent:main:first", "agent:main:second", "global"];
    const result = {
      ...snapshot.result,
      sessions: keys.map((key, index) => ({
        key,
        label: `Session ${index + 1}`,
        agentId: "main",
        hasContextWeight: index < 2,
        usage: snapshot.result.totals,
      })),
    };
    const first = deferred<SessionsUsageResult>();
    const second = deferred<SessionsUsageResult>();
    const request = vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        _options?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        if (method === "sessions.usage") {
          if (params?.key === keys[0]) {
            return first.promise;
          }
          if (params?.key === keys[1]) {
            return second.promise;
          }
          return result;
        }
        return { providers: [], logs: [], points: [] };
      },
    );
    const { context, page } = await loadUsagePage(request);
    const initial = request.mock.calls.find(([method]) => method === "sessions.usage")!;
    expect(initial[1]).toMatchObject({ includeContextWeight: false });
    expect(request.mock.calls.filter(([, params]) => params?.key)).toHaveLength(0);

    const selectSession = (index: number) => selectUsageSession(page, index);
    selectSession(0);
    await waitForFast(() => expect(textOf(page, ".context-details-panel")).toContain("Loading"));
    const firstContext = request.mock.calls.find(
      ([method, params]) => method === "sessions.usage" && params?.key === keys[0],
    )!;
    expect(firstContext[1]).toMatchObject({
      key: keys[0],
      includeContextWeight: true,
    });
    expect(firstContext[2]?.signal?.aborted).toBe(false);

    selectSession(1);
    expect(firstContext[2]?.signal?.aborted).toBe(true);
    first.resolve({
      ...result,
      sessions: [{ ...result.sessions[0]!, contextWeight: contextWeight("stale-context") }],
    });
    second.reject(new Error("context unavailable"));
    await waitForFast(() =>
      expect(textOf(page, ".usage-detail-error--context")).toContain("context unavailable"),
    );
    expect(textOf(page, ".context-details-panel")).not.toContain("stale-context");
    expect(textOf(page, ".context-details-panel")).not.toContain("No context data");

    request.mockImplementation(async (method, params) =>
      method === "sessions.usage" && params?.key === keys[1]
        ? {
            ...result,
            sessions: [
              { ...result.sessions[1]!, contextWeight: contextWeight("selected-context") },
            ],
          }
        : method === "sessions.usage"
          ? { ...result, sessions: params?.key ? [result.sessions[2]!] : result.sessions }
          : { logs: [], points: [] },
    );
    expect(page.querySelector(".usage-detail-error--context button")).toBeNull();
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    await waitForFast(() =>
      expect(textOf(page, ".context-details-panel")).toContain("selected-context"),
    );
    expect(page.querySelector(".usage-detail-error--context")).toBeNull();
    expect(
      request.mock.calls.filter(([method, params]) => method === "sessions.usage" && !params?.key),
    ).toHaveLength(3);
    const contextCalls = usageCalls(request).length;
    selectSession(2);
    await waitForFast(() =>
      expect(textOf(page, ".context-details-panel")).toContain("No context data"),
    );
    expect(usageCalls(request)).toHaveLength(contextCalls + 2);
  });

  it("refreshes selected details and clears context when its report disappears", async () => {
    const snapshot = cacheSnapshot("fresh");
    const timestamp = new Date().setHours(12, 0, 0, 0);
    let turns = 2;
    let available = true;
    let report = "original-context";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const totals = {
        ...snapshot.result.totals,
        input: turns * 100,
        totalTokens: turns * 100,
        totalCost: turns * 0.1,
        inputCost: turns * 0.1,
      };
      if (method === "sessions.usage") {
        const session = {
          key: "agent:main:context",
          label: "Context session",
          agentId: "main",
          hasContextWeight: available,
          usage: totals,
        };
        return {
          ...snapshot.result,
          totals,
          sessions: [
            params?.key
              ? { ...session, contextWeight: available ? contextWeight(report) : null }
              : session,
          ],
        };
      }
      if (method === "sessions.usage.timeseries") {
        return {
          points: usagePoints(timestamp, turns, 0.1),
        };
      }
      if (method === "sessions.usage.logs") {
        return {
          logs: [{ timestamp, role: "assistant", content: `${turns} completed turns` }],
        };
      }
      return { providers: [] };
    });
    const { page } = await loadUsagePage(request);
    selectUsageSession(page);
    await waitForFast(() => expect(textOf(page, ".context-details-panel")).toContain(report));
    expect(textOf(page, ".timeseries-summary")).toContain("200");
    expect(textOf(page, ".session-log-content")).toBe("2 completed turns");

    turns = 3;
    report = "refreshed-context";
    refreshButton(page).click();
    await waitForFast(() => expect(textOf(page, ".context-details-panel")).toContain(report));
    expect(textOf(page, ".session-detail-stats")).toContain("300");
    expect.soft(textOf(page, ".timeseries-summary")).toContain("300");
    expect.soft(textOf(page, ".session-log-content")).toBe("3 completed turns");
    const contextRequests = request.mock.calls.filter(
      ([method, params]) => method === "sessions.usage" && params?.key,
    ).length;
    available = false;
    refreshButton(page).click();
    await waitForFast(() =>
      expect(textOf(page, ".context-details-panel")).toContain("No context data"),
    );
    expect(
      request.mock.calls.filter(([method, params]) => method === "sessions.usage" && params?.key),
    ).toHaveLength(contextRequests + 1);
    expect(textOf(page, ".context-details-panel")).not.toContain(report);
  });

  it("exports every matching canonical row with context and cancels when scope changes", async () => {
    const snapshot = cacheSnapshot("fresh");
    const sessions = Array.from({ length: 81 }, (_, index) => ({
      key: `agent:main:export-${index}`,
      agentId: "main",
      sessionId: `instance-${index}`,
      label: index < 80 ? `Included ${index}` : "Excluded",
      hasContextWeight: true,
      usage: snapshot.result.totals,
    }));
    const result = { ...snapshot.result, sessions };
    let pending = deferred<SessionsUsageResult>();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return params?.includeContextWeight ? pending.promise : result;
      }
      return { providers: [] };
    });
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const { page } = await loadUsagePage(request);
    await queryUsagePage(page, "label:Included");
    const exportJson = () => selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
    await exportJson();
    await page.updateComplete;
    expect(page.querySelector(".usage-export-menu > button")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    const exported = request.mock.calls.find(([, params]) => params?.includeContextWeight)!;
    expect(exported[1]).toMatchObject({
      query: "label:Included",
      limit: Number.MAX_SAFE_INTEGER,
      includeContextWeight: true,
    });
    expect(exported[1]).not.toHaveProperty("projection");
    expect(exported[1]).not.toHaveProperty("offset");
    const full = {
      ...result,
      sessions: sessions.map((session) =>
        Object.assign({}, session, { contextWeight: contextWeight(session.label) }),
      ),
    };
    pending.resolve(full);
    await waitForFast(() => expect(download).toHaveBeenCalledOnce());
    const payload = JSON.parse(download.mock.calls[0]![1]) as { sessions: UsageSessionEntry[] };
    expect(payload.sessions).toHaveLength(80);
    expect(payload.sessions.at(-1)).toMatchObject({
      key: "agent:main:export-79",
      contextWeight: contextWeight("Included 79"),
    });
    expect(payload.sessions.some((session) => session.label === "Excluded")).toBe(false);
    pending = deferred<SessionsUsageResult>();
    await exportJson();
    await page.updateComplete;
    usageButton(page, "Current instance").click();
    await page.updateComplete;
    pending.resolve(full);
    await waitForFast(() => expect(refreshButton(page).disabled).toBe(false));
    expect(download).toHaveBeenCalledOnce();
  });

  it("keeps rejected provider usage retries unresolved until the page reports a stall", async () => {
    vi.useFakeTimers();
    focusDocument();
    let rejectProviderUsage = true;
    const request = vi.fn(async (method: string) => {
      if (method === "usage.status") {
        if (rejectProviderUsage) {
          throw new Error("provider usage unavailable");
        }
        return { updatedAt: 2, providers: [] };
      }
      return cacheSnapshot("fresh").result;
    });
    const { page } = await createUsagePageFixture(request, false);
    const gateway = page.context.gateway;
    page.routeData = {
      ...createPendingUsageRouteData(gateway, "2026-05-14"),
      loadedAtMs: 1,
    } satisfies UsageRouteData;
    await page.updateComplete;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
    }

    // Route data carries only session usage, so the page makes the first provider read
    // itself when it applies; that read plus the three-attempt retry budget makes four.
    expect(usageCalls(request, "usage.status")).toHaveLength(4);
    expect(page.read().data.providerUsageStalled).toBe(true);
    // Retries for incomplete provider plans never re-read session usage.
    expect(usageCalls(request, "sessions.usage")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(usageCalls(request, "usage.status")).toHaveLength(4);

    rejectProviderUsage = false;
    await page.refresh();
    expect(page.read().data.providerUsageStalled).toBe(false);
  });
});
