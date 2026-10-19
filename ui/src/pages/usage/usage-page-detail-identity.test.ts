/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { UsageSessionEntry } from "./types.ts";
import {
  createUsagePageFixture,
  usageCalls,
  textOf,
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  focusDocument,
  preloadUsage,
  refreshButton,
  usagePoints,
} from "./usage-page.test-support.ts";

beforeEach(focusDocument);
afterEach(cleanupUsagePageTest);

function overviewFixture(row: Partial<UsageSessionEntry> = {}) {
  const { result } = cacheSnapshot("fresh");
  const session: UsageSessionEntry = {
    key: "global",
    agentId: "main",
    usage: { ...result.totals },
    ...row,
  };
  return { ...result, sessions: [session] };
}

function usageRequest(handlers: Record<string, () => unknown>) {
  return vi.fn(async (method: string, _params?: Record<string, unknown>) =>
    handlers[method] ? handlers[method]() : { providers: [] },
  );
}

function readOverview(
  result: ReturnType<typeof overviewFixture>,
  patch: Partial<UsageSessionEntry> = {},
) {
  const row = result.sessions[0]!;
  return { ...result, sessions: [{ ...row, usage: { ...row.usage }, ...patch }] };
}

async function selectSession(request: Parameters<typeof createUsagePageFixture>[0]) {
  const fixture = await createUsagePageFixture(request);
  await preloadUsage(fixture.page);
  fixture.page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
  return fixture;
}

async function timelineFixture(sessionId: string | undefined, turnText?: string) {
  const overview = overviewFixture({ sessionId, label: turnText ? "Original summary" : undefined });
  const state = {
    row: overview.sessions[0]!,
    points: usagePoints(new Date().setHours(12, 0, 0, 0), 3),
  };
  const request = usageRequest({
    "sessions.usage": () => readOverview(overview),
    "sessions.usage.timeseries": () => ({ sessionId: state.row.sessionId, points: state.points }),
    "sessions.usage.logs": () => ({
      logs: state.points.map(({ timestamp }, index) => ({
        timestamp,
        role: turnText ? "user" : "assistant",
        content: turnText ?? `${state.row.sessionId} reply ${index + 1}`,
      })),
    }),
  });
  return { ...(await selectSession(request)), request, state, overview };
}

async function refreshOverview(
  { page, context }: Awaited<ReturnType<typeof createUsagePageFixture>>,
  kind: string,
) {
  if (kind === "manual") {
    refreshButton(page).click();
  } else {
    context.publishUsage({ usageUpdatedAt: 1 });
    await vi.waitFor(() => expect(page.read().data.loading).toBe(false));
  }
}

function dragTimelineRange(page: Pick<HTMLElement, "querySelector">) {
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

it.each([
  { refresh: "automatic", points: 1, activeDrag: false },
  { refresh: "manual", points: 2, activeDrag: true },
])(
  "retires range after $refresh replacement ($points points, dragging=$activeDrag)",
  async ({ refresh, points, activeDrag }) => {
    const fixture = await timelineFixture("original-instance");
    const { page, state } = fixture;
    await vi.waitFor(() => expect(page.querySelectorAll(".session-log-entry")).toHaveLength(3));
    const drag = dragTimelineRange(page);
    try {
      await page.updateComplete;
      expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
      if (!activeDrag) {
        drag.end();
      }
      state.row.sessionId = "replacement-instance";
      state.points = usagePoints(state.points[0]!.timestamp + 60_000, points);
      await refreshOverview(fixture, refresh);
      await vi.waitFor(() =>
        expect(page.read().detail.timeSeries?.sessionId).toBe(state.row.sessionId),
      );
      if (activeDrag) {
        drag.move();
      }
      await page.updateComplete;
      expect.soft(page.usageSelectedSessions).toEqual(["global"]);
      expect
        .soft([...page.querySelectorAll(".session-log-content")].map((entry) => entry.textContent))
        .toEqual(state.points.map((_, index) => `${state.row.sessionId} reply ${index + 1}`));
      expect.soft(page.querySelector(".timeseries-summary__range")).toBeNull();
      expect.soft(textOf(page, ".session-logs-header-count")).not.toContain("timeline filtered");
    } finally {
      drag.end();
    }
  },
);

it.each([
  { replacement: "owner", refresh: "manual" },
  { replacement: "instance", refresh: "automatic" },
])(
  "retires old-$replacement details and pending recovery on $refresh refresh",
  async ({ replacement, refresh }) => {
    const overview = overviewFixture({ sessionId: "original-instance", label: "Original session" });
    const row = overview.sessions[0]!;
    const retired = deferred<SessionUsageTimeSeries>();
    let holdOriginal = false;
    let replaced = false;
    const detailResponse = (method: "logs" | "timeseries") => {
      if (replaced) {
        throw new Error("Replacement details unavailable");
      }
      return holdOriginal
        ? retired.promise
        : method === "logs"
          ? { logs: [{ timestamp: 1, role: "user", content: "Original turn" }] }
          : { sessionId: "original-instance", points: [] };
    };
    const request = usageRequest({
      "sessions.usage": () => readOverview(overview),
      "sessions.usage.logs": () => detailResponse("logs"),
      "sessions.usage.timeseries": () => detailResponse("timeseries"),
    });
    const fixture = await selectSession(request);
    const { context, page } = fixture;
    await vi.waitFor(() => expect(page.textContent).toContain("Original turn"));
    expect(page.read().detail.timeSeries?.sessionId).toBe("original-instance");

    holdOriginal = true;
    const oldLoad = page.refresh();
    await vi.waitFor(() => expect(page.read().detail.timeSeriesLoading).toBe(true));
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    replaced = true;
    row.label = "Replacement session";
    if (replacement === "owner") {
      row.agentId = "opus";
    } else {
      row.sessionId = "replacement-instance";
    }
    const beforeRefresh = request.mock.calls.length;
    await refreshOverview(fixture, refresh);
    await vi.waitFor(() =>
      expect(textOf(page, ".session-bar-selection")).toContain("Replacement session"),
    );
    expect.soft(page.usageSelectedSessions).toEqual(["global"]);
    expect.soft(page.read().detail).toMatchObject({ timeSeries: null, sessionLogs: null });
    retired.resolve({ sessionId: "retired-instance", points: [] });
    await oldLoad;
    await vi.waitFor(() => {
      expect(page.read().detail).toMatchObject({
        timeSeriesLoading: false,
        sessionLogsLoading: false,
      });
    });
    expect.soft(page.read().detail).toMatchObject({
      timeSeries: null,
      sessionLogs: null,
      timeSeriesStatus: { error: "Replacement details unavailable" },
      sessionLogsStatus: { error: "Replacement details unavailable" },
    });
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      const requests = request.mock.calls.slice(beforeRefresh).filter(([name]) => name === method);
      expect.soft(requests, method).toHaveLength(1);
      expect.soft(requests[0]?.[1], method).toEqual({
        key: "global",
        agentId: row.agentId,
        ...(method === "sessions.usage.logs" ? { limit: 1000 } : {}),
      });
    }
  },
);

it.each([
  { sessionId: undefined, refresh: "automatic" },
  { sessionId: "stable-instance", refresh: "manual" },
])(
  "retains details and range on $refresh refresh of instance $sessionId",
  async ({ sessionId, refresh }) => {
    const fixture = await timelineFixture(sessionId, "Retained turn");
    const { context, page, request, state, overview } = fixture;
    await vi.waitFor(() => expect(page.textContent).toContain("Retained turn"));
    dragTimelineRange(page).end();
    await page.updateComplete;
    expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
    const range = textOf(page, ".timeseries-summary__range");
    const timeSeries = page.read().detail.timeSeries;
    const logs = page.read().detail.sessionLogs;
    state.row.label = "Refreshed summary";
    state.row.usage!.input = state.row.usage!.totalTokens = 350;
    overview.updatedAt += 1;
    await refreshOverview(fixture, refresh);
    await vi.waitFor(() =>
      expect(textOf(page, ".session-bar-selection")).toContain(state.row.label),
    );
    await vi.waitFor(() => expect(page.read().detail.timeSeriesLoading).toBe(false));
    await page.updateComplete;
    expect(textOf(page, ".session-bar-selection")).toContain(state.row.label);
    await vi.waitFor(() => expect(page.read().data.selectedSession?.usage?.totalTokens).toBe(350));
    expect(textOf(page, ".session-detail-stats strong")).toBe("200");
    expect(page.usageSelectedSessions).toEqual(["global"]);
    expect(page.read().detail.timeSeries).toEqual(timeSeries);
    expect(page.read().detail.sessionLogs).toEqual(logs);
    expect(page.querySelectorAll(".session-log-entry")).toHaveLength(2);
    expect(textOf(page, ".timeseries-summary__range")).toBe(range);
    const summaryReads = usageCalls(request).length;
    context.publishUsage({ usageUpdatedAt: 2 });
    await vi.waitFor(() => expect(page.read().data.loading).toBe(false));
    expect(usageCalls(request)).toHaveLength(summaryReads + 1);
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      expect(usageCalls(request, method), method).toHaveLength(refresh === "manual" ? 2 : 1);
    }
    [...page.querySelectorAll<HTMLButtonElement>(".timeseries-controls button")]
      .find((button) => button.textContent?.trim() === "Reset")!
      .click();
    await page.updateComplete;
    expect(page.querySelector(".session-detail-indicator")).toBeNull();
    expect(textOf(page, ".session-detail-stats strong")).toBe("350");
  },
);

it.each([
  { captured: "selected-instance", returned: "retired-instance", conflict: true },
  { captured: "selected-instance", returned: undefined, conflict: false },
  { captured: undefined, returned: "selected-instance", conflict: false },
])(
  "binds context response $returned to optional captured instance $captured",
  async ({ captured, returned, conflict }) => {
    const overview = overviewFixture({
      agentId: "opus",
      sessionId: captured,
      hasContextWeight: true,
    });
    let returnedId = returned;
    let report = "Initial context";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return readOverview(
          overview,
          params?.key ? { sessionId: returnedId, contextWeight: contextWeight(report) } : {},
        );
      }
      return { providers: [], logs: [], points: [] };
    });
    const { page } = await selectSession(request);
    await vi.waitFor(() => expect(page.read().detail.context.loading).toBe(false));
    await page.updateComplete;
    if (conflict) {
      expect.soft(page.read().detail.context.weight).toBeUndefined();
      expect
        .soft(page.read().detail.context.status.error)
        .toBe("These context details are out of date. Refresh usage and try again.");
      expect.soft(textOf(page, ".context-details-panel")).not.toContain(report);
    } else {
      expect(page.read().detail.context.weight).toEqual(contextWeight(report));
      expect(page.read().detail.context.status.error).toBeNull();
    }
    returnedId = captured;
    report = "Recovered context";
    refreshButton(page).click();
    await vi.waitFor(() =>
      expect(page.read().detail.context.weight).toEqual(contextWeight(report)),
    );
    expect(page.read().detail.context.status.error).toBeNull();
    expect(page.usageSelectedSessions).toEqual(["global"]);
    for (const [method, params] of request.mock.calls) {
      if (method === "sessions.usage" && params?.key) {
        expect(params).not.toHaveProperty("sessionId");
      }
    }
  },
);
