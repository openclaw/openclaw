import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  askLogbook,
  configureLogbookPolling,
  getLogbookState,
  loadLogbook,
  loadLogbookStandup,
  runLogbookAnalysisNow,
  stopLogbookPolling,
  type LogbookStatusPayload,
} from "./logbook-controller.ts";

function clientWithRequest(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusFor(day: string): LogbookStatusPayload {
  return {
    captureEnabled: true,
    capturePaused: false,
    captureIntervalSeconds: 30,
    analysisIntervalMinutes: 15,
    retentionDays: 30,
    pendingFrames: 0,
    analysisRunning: false,
    visionModelSource: "missing",
    today: day,
    todayCards: 1,
    timeZone: "UTC",
  };
}

function timelineFor(day: string, title: string) {
  return {
    day,
    cards: [
      {
        id: 1,
        day,
        startMs: 1,
        endMs: 2,
        title,
        summary: "Summary",
        detail: "",
        category: "Coding",
        distractions: [],
      },
    ],
    stats: { trackedMs: 1, distractionMs: 0, categories: [], apps: [] },
  };
}

describe("Logbook controller", () => {
  const hosts: object[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      stopLogbookPolling(host);
    }
    vi.useRealTimers();
  });

  it("rebinds polling when the gateway client changes", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    const firstRequest = vi.fn(async () => ({}));
    const secondRequest = vi.fn(async () => ({}));

    configureLogbookPolling(state, clientWithRequest(firstRequest), true);
    configureLogbookPolling(state, clientWithRequest(secondRequest), true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(firstRequest).not.toHaveBeenCalled();
    expect(secondRequest).toHaveBeenCalled();
  });

  it("does not overlap silent poll refreshes and resumes after settlement", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const firstBatch = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      const pending = firstBatch.get(method);
      if (pending) {
        firstBatch.delete(method);
        return pending.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Resumed poll"));
    });

    configureLogbookPolling(state, clientWithRequest(request), true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(request).toHaveBeenCalledTimes(3);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "First poll"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("First poll");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.filter(([method]) => method === "logbook.status")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "logbook.days")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "logbook.timeline")).toHaveLength(2);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("retires a pending poll refresh when the client changes", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const oldStatus = deferred<unknown>();
    const oldDays = deferred<unknown>();
    const oldTimeline = deferred<unknown>();
    const oldResponses = new Map([
      ["logbook.status", oldStatus],
      ["logbook.days", oldDays],
      ["logbook.timeline", oldTimeline],
    ]);
    const oldRequest = vi.fn((method: string) => {
      const response = oldResponses.get(method);
      if (!response) {
        throw new Error(`Unexpected old-client request: ${method}`);
      }
      return response.promise;
    });
    const newRequest = vi.fn(async (method: string) => {
      if (method === "logbook.status") {
        return statusFor("2026-07-04");
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return timelineFor("2026-07-04", "New client");
    });

    configureLogbookPolling(state, clientWithRequest(oldRequest), true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(oldRequest).toHaveBeenCalledTimes(3);

    configureLogbookPolling(state, clientWithRequest(newRequest), true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(newRequest).toHaveBeenCalledTimes(3);
    expect(state.timeline?.cards[0]?.title).toBe("New client");

    oldStatus.resolve(statusFor("2026-07-04"));
    oldDays.resolve({ days: [] });
    oldTimeline.resolve(timelineFor("2026-07-04", "Retired client"));
    await vi.advanceTimersByTimeAsync(0);

    expect(state.timeline?.cards[0]?.title).toBe("New client");
  });

  it("shares the background refresh owner with analysis completion", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return Promise.resolve({ started: true });
      }
      const response = pending.get(method);
      if (response) {
        pending.delete(method);
        return response.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Resumed poll"));
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await runLogbookAnalysisNow(state, client);
    expect(request).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Analysis refresh"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("Analysis refresh");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(7);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("queues an analysis refresh behind an in-flight poll", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return Promise.resolve({ started: true });
      }
      const response = pending.get(method);
      if (response) {
        pending.delete(method);
        return response.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Post-analysis refresh"));
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    await runLogbookAnalysisNow(state, client);
    expect(request).toHaveBeenCalledTimes(4);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Pre-analysis refresh"));
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(7);
    expect(state.timeline?.cards[0]?.title).toBe("Post-analysis refresh");
  });

  it("does not refresh a retired client after analysis settles", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const analysis = deferred<unknown>();
    const oldRequest = vi.fn((method: string) => {
      if (method !== "logbook.analyze.now") {
        throw new Error(`Unexpected retired-client request: ${method}`);
      }
      return analysis.promise;
    });
    const newRequest = vi.fn(async (method: string) => {
      if (method === "logbook.status") {
        return statusFor("2026-07-04");
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return timelineFor("2026-07-04", "New client");
    });
    const oldClient = clientWithRequest(oldRequest);

    configureLogbookPolling(state, oldClient, true);
    const action = runLogbookAnalysisNow(state, oldClient);
    configureLogbookPolling(state, clientWithRequest(newRequest), true);

    analysis.resolve({ started: true });
    await action;
    await vi.advanceTimersByTimeAsync(0);
    expect(oldRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(newRequest).toHaveBeenCalledTimes(3);
    expect(state.timeline?.cards[0]?.title).toBe("New client");
  });

  it("does not let an older day load overwrite a newer selection", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    const oldStatus = deferred<unknown>();
    const oldDays = deferred<unknown>();
    const oldTimeline = deferred<unknown>();
    const oldResponses = new Map([
      ["logbook.status", oldStatus],
      ["logbook.days", oldDays],
      ["logbook.timeline", oldTimeline],
    ]);
    const oldRequest = vi.fn((method: string) => {
      const response = oldResponses.get(method);
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response.promise;
    });
    const newerRequest = vi.fn(async (method: string) => {
      if (method === "logbook.status") {
        return statusFor("2026-07-05");
      }
      if (method === "logbook.days") {
        return { days: [{ day: "2026-07-05", cards: 1, firstMs: 1, lastMs: 2 }] };
      }
      return timelineFor("2026-07-05", "New day");
    });

    const olderLoad = loadLogbook(state, clientWithRequest(oldRequest), { day: "2026-07-04" });
    expect(oldRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });

    await loadLogbook(state, clientWithRequest(newerRequest), { day: "2026-07-05" });
    expect(newerRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-05" });
    expect(state.timeline?.cards[0]?.title).toBe("New day");

    oldStatus.resolve(statusFor("2026-07-04"));
    oldDays.resolve({ days: [{ day: "2026-07-04", cards: 1, firstMs: 1, lastMs: 2 }] });
    oldTimeline.resolve(timelineFor("2026-07-04", "Old day"));
    await olderLoad;

    expect(state.day).toBe("2026-07-05");
    expect(state.status?.today).toBe("2026-07-05");
    expect(state.days[0]?.day).toBe("2026-07-05");
    expect(state.timeline?.cards[0]?.title).toBe("New day");
    expect(state.loading).toBe(false);
  });

  it("discards a standup response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    const pending = deferred<unknown>();
    const request = loadLogbookStandup(
      state,
      clientWithRequest(() => pending.promise),
      false,
    );

    state.day = "2026-07-05";
    pending.resolve({ day: "2026-07-04", text: "Old day", updatedMs: 1 });
    await request;

    expect(state.standup).toBeNull();
  });

  it("discards an ask response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.askQuestion = "What did I do?";
    const pending = deferred<unknown>();
    const request = askLogbook(
      state,
      clientWithRequest(() => pending.promise),
    );

    state.day = "2026-07-05";
    pending.resolve({ answer: "Old day" });
    await request;

    expect(state.askAnswer).toBeNull();
  });
});
