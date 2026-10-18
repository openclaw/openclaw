import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createLogbook } from "./logbook-state.ts";
import type { LogbookStatusPayload } from "./logbook-types.ts";

function clientWithRequest(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
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

describe("Logbook request ownership", () => {
  const disposals: Array<() => void> = [];
  const createModel = () =>
    createRoot((dispose) => {
      disposals.push(dispose);
      return createLogbook();
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 4, 12));
  });

  afterEach(() => {
    for (const dispose of disposals.splice(0)) {
      dispose();
    }
    vi.useRealTimers();
  });

  it("does not overlap silent poll refreshes and resumes after settlement", async () => {
    vi.useFakeTimers();
    const model = createModel();
    const state = model.state;
    const status = createDeferred<unknown>();
    const days = createDeferred<unknown>();
    const timeline = createDeferred<unknown>();
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

    model.connect(clientWithRequest(request));
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

  it("shares the background refresh owner with analysis completion", async () => {
    vi.useFakeTimers();
    const model = createModel();
    const state = model.state;
    const status = createDeferred<unknown>();
    const days = createDeferred<unknown>();
    const timeline = createDeferred<unknown>();
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

    model.connect(client);
    await model.analyze();
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

  it("keeps the replacement analysis locked until its own request settles", async () => {
    const model = createModel();
    const state = model.state;
    const oldAnalysis = createDeferred<unknown>();
    const newAnalysis = createDeferred<unknown>();
    const oldClient = clientWithRequest(() => oldAnalysis.promise);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return newAnalysis.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor(state.day));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor(state.day, "Current analysis"));
    });
    const newClient = clientWithRequest(request);
    model.connect(oldClient);
    const oldRequest = model.analyze();
    model.connect(newClient);
    const newRequest = model.analyze();

    oldAnalysis.resolve({ started: true });
    await oldRequest;
    expect(state.actionPending).toBe(true);
    await model.analyze();
    expect(request).toHaveBeenCalledTimes(1);

    newAnalysis.resolve({ started: true });
    await newRequest;
    expect(state.actionPending).toBe(false);
  });

  it("discards a capture result from a retired polling client", async () => {
    const model = createModel();
    const state = model.state;
    const oldStatus = createDeferred<unknown>();
    const oldClient = clientWithRequest(() => oldStatus.promise);
    const newStatus = { ...statusFor("2026-07-05"), capturePaused: true };
    const newClient = clientWithRequest(() => Promise.resolve(newStatus));

    model.connect(oldClient);
    const oldRequest = model.setCapturePaused(true);
    model.connect(newClient);
    await model.setCapturePaused(true);
    expect(state.status).toEqual(newStatus);

    oldStatus.resolve(statusFor("2026-07-04"));
    await oldRequest;
    expect(state.status).toEqual(newStatus);
    expect(state.actionPending).toBe(false);
  });

  it("queues an analysis refresh behind an in-flight poll", async () => {
    vi.useFakeTimers();
    const model = createModel();
    const state = model.state;
    const status = createDeferred<unknown>();
    const days = createDeferred<unknown>();
    const timeline = createDeferred<unknown>();
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

    model.connect(client);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    await model.analyze();
    expect(request).toHaveBeenCalledTimes(4);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Pre-analysis refresh"));
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(7);
    expect(state.timeline?.cards[0]?.title).toBe("Post-analysis refresh");
  });

  it("drops a queued analysis refresh when polling stops", async () => {
    vi.useFakeTimers();
    const model = createModel();
    const state = model.state;
    const status = createDeferred<unknown>();
    const days = createDeferred<unknown>();
    const timeline = createDeferred<unknown>();
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
      if (!response) {
        throw new Error(`Unexpected refresh request: ${method}`);
      }
      pending.delete(method);
      return response.promise;
    });
    const client = clientWithRequest(request);

    model.connect(client);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);
    await model.analyze();
    expect(request).toHaveBeenCalledTimes(4);

    model.connect(null);
    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Detached host"));
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(4);
    expect(state.timeline).toBeNull();
  });

  it("does not let an older day load overwrite a newer selection", async () => {
    const model = createModel();
    const state = model.state;
    const oldStatus = createDeferred<unknown>();
    const oldDays = createDeferred<unknown>();
    const oldTimeline = createDeferred<unknown>();
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

    const oldClient = clientWithRequest(oldRequest);
    const newClient = clientWithRequest(newerRequest);
    model.connect(oldClient);
    const olderLoad = model.load({ day: "2026-07-04" });
    expect(oldRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });

    model.connect(newClient);
    await model.load({ day: "2026-07-05" });
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
    const model = createModel();
    const state = model.state;
    const pending = createDeferred<unknown>();
    const client = clientWithRequest((method) => {
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-05"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      if (method === "logbook.timeline") {
        return Promise.resolve(timelineFor("2026-07-05", "Next day"));
      }
      return pending.promise;
    });
    model.connect(client);
    const request = model.standup(false);

    await model.load({ day: "2026-07-05" });
    pending.resolve({ day: "2026-07-04", text: "Old day", updatedMs: 1 });
    await request;

    expect(state.standup).toBeNull();
  });

  it("discards an ask response after the selected day changes", async () => {
    const model = createModel();
    const state = model.state;
    const pending = createDeferred<unknown>();
    const client = clientWithRequest((method) => {
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-05"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      if (method === "logbook.timeline") {
        return Promise.resolve(timelineFor("2026-07-05", "Next day"));
      }
      return pending.promise;
    });
    model.connect(client);
    const request = model.ask("What did I do?");

    await model.load({ day: "2026-07-05" });
    pending.resolve({ answer: "Old day" });
    await request;

    expect(state.askAnswer).toBeNull();
  });
});
