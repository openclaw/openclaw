// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  sessionActivityListing,
  useSessionActivityControllerFixture,
} from "./session-activity-controller.test-support.ts";
import { ACTIVITY_SUMMARY_ENSURE_METHOD, createSessionActivity } from "./session-activity-owner.ts";

type BackfillResponse =
  | SessionsListResult
  | { sessions: Array<Pick<GatewaySessionRow, "key" | "agentId" | "activitySummary">> };

const result = sessionActivityListing([]);
const { active, setup } = useSessionActivityControllerFixture();
let client: ReturnType<typeof setup>["client"];
let controller: ReturnType<typeof createSessionActivity>;
const dayAt = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
  new Date(year, month, day, hour, minute);
let request: ReturnType<typeof setup>["request"];
let held: ReturnType<typeof createDeferred<BackfillResponse>>;
const pulse = (index: number) =>
  request.mock.calls[index]![1] as { activityPulseBoundaries: number[]; activeMinutes?: number };
const advance = async (ms: number, calls: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  expect(request).toHaveBeenCalledTimes(calls);
};
beforeEach(() => {
  vi.useFakeTimers();
  ({ client, controller, request } = setup());
  request.mockResolvedValue(result);
  held = createDeferred<BackfillResponse>();
});
afterEach(async () => {
  held.resolve(result);
  controller.dispose();
  await held.promise;
  vi.unstubAllGlobals();
});

it("retains same-query rows across conditional refreshes and clears changed people", async () => {
  const filters = { personId: "former", time: "all" as const, query: "" };
  const initial = sessionActivityListing([active], {
    rowsRevision: "first",
    involvingProfileId: "current",
  });
  request.mockResolvedValueOnce(initial);
  await controller.load(client, filters);
  expect(controller.result).toEqual(initial);
  request.mockResolvedValueOnce(
    sessionActivityListing([], {
      rowsRevision: "first",
      rowsUnchanged: true,
      count: 1,
      totalCount: 20,
    }),
  );
  const refreshing = controller.load(client, filters, "refresh");
  expect(controller.result).toEqual(initial);
  await refreshing;
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({
      ifRowsRevision: "delta:first",
      involvingProfileId: "former",
      excludeDock: true,
      includePeople: true,
      sortBy: "activity",
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(controller.result).toMatchObject({ sessions: [active], totalCount: 20 });
  const renamed = { ...active, label: "Renamed" };
  request.mockResolvedValueOnce(
    sessionActivityListing([renamed], {
      rowsRevision: "next",
      rowsDelta: { baseRevision: "first", order: [1] },
    }),
  );
  await controller.load(client, filters, "refresh");
  expect(controller.result?.sessions).toEqual([renamed]);
  void controller.load(client, { ...filters, personId: "other" });
  expect(controller.result).toBeUndefined();
});

it("requests calendar-aligned pulse windows, including clock-change dates", async () => {
  const windows = [
    ["24h", dayAt(8, 27, 14, 30), 26, dayAt(8, 26, 14), dayAt(8, 27, 15), 1440],
    ["7d", dayAt(8, 27, 14, 30), 9, dayAt(8, 20), dayAt(8, 28), 10080],
    ["30d", dayAt(8, 27, 14, 30), 32, dayAt(7, 28), dayAt(8, 28), 43200],
    ["all", dayAt(8, 27, 14, 30), 13, dayAt(9, 1, 0, 0, 2025), dayAt(9, 1), undefined],
    ["24h", dayAt(3, 5, 15, 30), 26, null, dayAt(3, 5, 16), 1440],
    ["24h", dayAt(9, 4, 15, 30), 26, null, dayAt(9, 4, 16), 1440],
    ["7d", dayAt(2, 10, 12), 9, dayAt(2, 3), dayAt(2, 11), 10080],
    ["7d", dayAt(10, 3, 12), 9, dayAt(9, 27), dayAt(10, 4), 10080],
  ] as const;
  for (const [index, [time, now, count, first, last, activeMinutes]] of windows.entries()) {
    vi.setSystemTime(now);
    await controller.load(client, { personId: null, time, query: "" });
    expect(request).toHaveBeenCalledTimes(index + 1);
    const params = pulse(index);
    const boundaries = params.activityPulseBoundaries;
    const oldest = new Date(now.getTime() - 24 * 3_600_000);
    oldest.setMinutes(0, 0, 0);
    expect(boundaries).toHaveLength(count);
    expect(boundaries[0]).toBe((first ?? oldest).getTime());
    expect(boundaries.at(-1)).toBe(last.getTime());
    expect(boundaries.every((value, i) => i === 0 || value > boundaries[i - 1]!)).toBe(true);
    expect(params.activeMinutes).toBe(activeMinutes);
    expect(params).not.toHaveProperty("activityPulseSince");
    expect(params).not.toHaveProperty("activityPulseUntil");
    for (const [i, boundary] of boundaries.entries()) {
      const date = new Date(boundary);
      expect([date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0]);
      if (time !== "24h") {
        expect(date.getHours()).toBe(0);
      }
      if (time === "all") {
        expect(date.getDate()).toBe(1);
      }
      if (time === "7d") {
        expect(boundary).toBe(
          new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 + i).getTime(),
        );
      }
    }
  }
});

it.each([
  { time: "24h", month: 8, day: 27, hour: 14 },
  { time: "7d", month: 2, day: 8, hour: 23 },
  { time: "30d", month: 10, day: 1, hour: 23 },
  { time: "all", month: 8, day: 27, hour: 23 },
] as const)(
  "refreshes $time at the bucket end or next midnight and leaves current work unaggregated",
  async ({ time, month, day, hour }) => {
    vi.setSystemTime(new Date(2026, month, day, hour, 59));
    const filters = { personId: null, time, query: "" };
    await controller.load(client, filters);
    const { activityPulseBoundaries: initial } = pulse(0);
    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(1);

    await advance(60_999, 1);
    await advance(5_001, 2);
    const { activityPulseBoundaries: refreshed } = pulse(1);
    if (time === "all") {
      expect(refreshed).toEqual(initial);
    } else {
      expect(refreshed.slice(0, -1)).toEqual(initial.slice(1));
      expect(refreshed.at(-1)).toBeGreaterThan(initial.at(-1)!);
    }

    await controller.load(client, "current");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activityPulseBoundaries");
    await advance(24 * 3_600_000, 3);

    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(4);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await advance(24 * 3_600_000, 4);
  },
);

it.each([
  { action: "retry", phase: "pending" },
  { action: "retry", phase: "cooldown" },
  { action: "filter", phase: "pending" },
  { action: "filter", phase: "cooldown" },
])("bypasses automatic Activity $phase for an explicit $action", async ({ action, phase }) => {
  // Keep the independent midnight rollover out of this refresh-admission scenario.
  vi.setSystemTime(dayAt(8, 27, 12));
  const replacement = { ...result, ts: 2 };
  request
    .mockResolvedValueOnce(result)
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(replacement);
  const filters = { personId: null, time: "all" as const, query: "" };
  void controller.load(client, filters);
  await vi.advanceTimersByTimeAsync(0);
  controller.invalidate();
  await vi.advanceTimersByTimeAsync(5_000);
  controller.invalidate();
  if (phase === "cooldown") {
    await vi.advanceTimersByTimeAsync(1_000);
    held.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  }
  void controller.load(
    client,
    action === "filter" ? { ...filters, query: "replacement" } : filters,
    action === "retry" ? "retry" : "query",
  );
  expect(request).toHaveBeenCalledTimes(3);
  if (phase === "pending") {
    expect(request.mock.calls[1]![2]?.signal?.aborted).toBe(true);
  }
  await vi.advanceTimersByTimeAsync(0);
  held.resolve(result);
  await advance(15_000, 3);
  expect(controller.result).toEqual(replacement);
});

it("holds a trailing Activity refresh through page hiding and retires it on disconnect", async () => {
  const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const pageEvents = new EventTarget();
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  controller = createSessionActivity(() => {});
  const filters = { personId: null, time: "7d" as const, query: "" };
  void controller.load(client, filters);
  await vi.advanceTimersByTimeAsync(0);
  request.mockReturnValueOnce(held.promise);
  void controller.load(client, filters, "refresh");
  controller.invalidate();
  await vi.advanceTimersByTimeAsync(5_000);
  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  held.resolve(result);
  await advance(5_000, 2);
  documentEvents.visibilityState = "visible";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  pageEvents.dispatchEvent(new Event("pageshow"));
  await advance(0, 3);
  controller.invalidate();
  controller.dispose();
  await advance(5_000, 3);
});

describe("Activity recap generation", () => {
  const filters = { personId: null, time: "all" as const, query: "" };
  const recap = (text: string, state: "stale" | "unavailable" = "stale") => ({
    state,
    canEnsure: true,
    text,
    updatedAt: 1,
  });
  const row = (
    key = "agent:main:notes",
    overrides: Partial<GatewaySessionRow> = {},
  ): GatewaySessionRow => ({
    key,
    agentId: "main",
    sessionId: key,
    kind: "direct",
    updatedAt: 1,
    activitySummary: { state: "stale", canEnsure: true },
    ...overrides,
  });
  const listing = (sessions: GatewaySessionRow[]) =>
    sessionActivityListing(sessions, { totalCount: sessions.length });
  const updating = (...sessions: GatewaySessionRow[]) => ({
    sessions: sessions.map(({ key, agentId, activitySummary }) => ({
      key,
      agentId,
      activitySummary: { ...activitySummary, state: "updating" as const, canEnsure: true },
    })),
  });
  const waitForSummary = (index: number, value: string) =>
    vi.waitFor(() =>
      expect(controller.result?.sessions[index]?.activitySummary?.state).toBe(value),
    );
  const startBackfill = async (sessions: GatewaySessionRow[], ...responses: BackfillResponse[]) => {
    request.mockResolvedValueOnce(listing(sessions)).mockReturnValueOnce(held.promise);
    for (const response of responses) {
      request.mockResolvedValueOnce(response);
    }
    void controller.load(client, filters, "query", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  };
  const expectEnsure = (session: GatewaySessionRow) =>
    expect(request).toHaveBeenLastCalledWith(
      ACTIVITY_SUMMARY_ENSURE_METHOD,
      { sessions: [{ key: session.key, agentId: session.agentId }] },
      expect.anything(),
    );
  beforeEach(() => {
    vi.useRealTimers();
    request.mockRestore();
    request = vi.spyOn(client, "request");
  });

  it("rechecks latest row permissions before queued batches and does not consume skipped attempts", async () => {
    const sessions = Array.from({ length: 22 }, (_, index) => row(`agent:main:notes-${index}`));
    let currentRows = sessions;
    const batches: string[][] = [];
    request.mockImplementation(async (method, params) => {
      if (method === "sessions.list") {
        return listing(currentRows);
      }
      const batch = (params as { sessions: Array<{ key: string }> }).sessions;
      batches.push(batch.map(({ key }) => key));
      if (batches.length === 1) {
        return held.promise;
      }
      return updating(...batch.map(({ key }) => row(key)));
    });
    void controller.load(client, filters, "query", true);
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]).toHaveLength(20);
    const staleRow = sessions[20]!;
    currentRows = sessions.map((session, index) => ({
      ...session,
      activitySummary: {
        state: index < 20 ? ("updating" as const) : ("stale" as const),
        canEnsure: index !== 20,
      },
    }));
    void controller.load(client, filters, "refresh");
    await vi.waitFor(() => expect(controller.result?.sessions[20]).toEqual(currentRows[20]));
    controller.retrySummary(staleRow);
    controller.retrySummary(controller.result!.sessions[20]!);
    held.resolve({ sessions: [] });
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    expect(batches[1]).toEqual([sessions[21]!.key]);
    currentRows = controller.result!.sessions.map((session) =>
      Object.assign({}, session, {
        activitySummary: Object.assign({}, session.activitySummary, { canEnsure: true }),
      }),
    );
    void controller.load(client, filters, "refresh");
    await vi.waitFor(() => expect(batches).toHaveLength(3));
    expect(batches[2]).toEqual([staleRow.key]);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("does not let a delayed backfill response overwrite a newer session-list recap", async () => {
    const oldRow = row();
    const newRow = row(oldRow.key, {
      updatedAt: 2,
      activitySummary: { state: "current", text: "The repair is now merged.", updatedAt: 2 },
    });
    await startBackfill([oldRow], listing([newRow]));
    void controller.load(client, filters, "refresh");
    await vi.waitFor(() => expect(controller.result?.sessions[0]).toEqual(newRow));
    held.resolve(updating(oldRow));
    await held.promise;
    await Promise.resolve();
    expect(controller.result?.sessions[0]).toEqual(newRow);
  });

  it("backfills newly visible sessions after the current batch settles", async () => {
    const first = row();
    const added = row("agent:main:newly-visible");
    await startBackfill([first], listing([first, added]), updating(added));
    void controller.load(client, filters, "refresh");
    await vi.waitFor(() => expect(controller.result?.sessions).toEqual([first, added]));
    held.resolve(updating(first));
    await waitForSummary(1, "updating");
    expectEnsure(added);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each(["sessions.list", ACTIVITY_SUMMARY_ENSURE_METHOD])(
    "resumes recap generation after %s finishes in a hidden tab",
    async (heldMethod) => {
      const documentEvents = new EventTarget();
      const pageEvents = new EventTarget();
      let visibilityState = heldMethod === "sessions.list" ? "hidden" : "visible";
      Object.defineProperty(documentEvents, "visibilityState", { get: () => visibilityState });
      vi.stubGlobal("document", documentEvents);
      vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
      vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
      const source = row();
      const response = (method: string) =>
        method === "sessions.list" ? listing([source]) : updating(source);
      let intercepted = false;
      request.mockImplementation(async (method) => {
        if (method === heldMethod && !intercepted) {
          intercepted = true;
          return held.promise;
        }
        return response(method);
      });
      controller.dispose();
      controller = createSessionActivity(() => {});
      void controller.load(client, filters, "query", true);
      await vi.waitFor(() => expect(intercepted).toBe(true));
      if (visibilityState !== "hidden") {
        visibilityState = "hidden";
        documentEvents.dispatchEvent(new Event("visibilitychange"));
      }
      held.resolve(response(heldMethod));
      await vi.waitFor(() => expect(controller.loading).toBe(false));
      const requestsWhileHidden = heldMethod === "sessions.list" ? 1 : 2;
      expect(request).toHaveBeenCalledTimes(requestsWhileHidden);
      expect(controller.result?.sessions[0]?.activitySummary?.state).toBe("stale");
      visibilityState = "visible";
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      await waitForSummary(0, "updating");
    },
  );

  it("retains a failed recap and retries it without turning the session list into an error", async () => {
    const source = row(undefined, {
      activitySummary: recap("Found the failure; verification remains."),
    });
    request
      .mockResolvedValueOnce(listing([source]))
      .mockRejectedValueOnce(new Error("Network interrupted"))
      .mockResolvedValueOnce(updating(source));
    void controller.load(client, filters, "query", true);
    await waitForSummary(0, "unavailable");
    expect(controller.result?.sessions[0]?.activitySummary?.text).toBe(
      source.activitySummary?.text,
    );
    expect(controller.error).toBeUndefined();
    controller.retrySummary(controller.result!.sessions[0]!);
    await waitForSummary(0, "updating");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops queued backfill batches when write access is revoked", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
    await startBackfill(sessions);
    void controller.load(client, filters, "query", false);
    controller.retrySummary(sessions[0]!);
    held.resolve(updating(...sessions.slice(0, 20)));
    await held.promise;
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.result?.sessions).toEqual(sessions);
  });

  it("keeps an explicit retry queued while another visible batch is pending", async () => {
    const retryRow = row("agent:main:retry", {
      activitySummary: recap("Previous recap", "unavailable"),
    });
    const pendingRow = row();
    await startBackfill([retryRow, pendingRow], updating(retryRow));
    controller.retrySummary(controller.result!.sessions[0]!);
    held.resolve(updating(pendingRow));
    await waitForSummary(0, "updating");
    expectEnsure(retryRow);
  });
});
