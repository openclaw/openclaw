import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createLogbook } from "./logbook-state.ts";
import {
  logbookClient as clientWithRequest,
  logbookStatus as statusFor,
  logbookTimeline,
} from "./logbook.test-support.ts";

function timelineFor(day: string, title: string) {
  return logbookTimeline(day, [{ title }], 1);
}

function pendingRefresh(title?: string) {
  const status = createDeferred<unknown>();
  const timeline = createDeferred<unknown>();
  const pending = new Map([
    ["logbook.status", status],
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
    if (title === undefined) {
      throw new Error(`Unexpected refresh request: ${method}`);
    }
    return Promise.resolve(
      method === "logbook.status" ? statusFor("2026-07-04") : timelineFor("2026-07-04", title),
    );
  });
  return {
    request,
    resolve(settledTitle: string) {
      status.resolve(statusFor("2026-07-04"));
      timeline.resolve(timelineFor("2026-07-04", settledTitle));
    },
  };
}

describe("Logbook request ownership", () => {
  const disposals: Array<() => void> = [];
  const createModel = (client: GatewayBrowserClient) =>
    createRoot((dispose) => {
      disposals.push(dispose);
      return Object.assign(createLogbook(client), { dispose });
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
    const { request, resolve } = pendingRefresh("Resumed poll");

    const model = createModel(clientWithRequest(request));
    const state = model.state;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(request).toHaveBeenCalledTimes(2);

    resolve("First poll");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("First poll");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.filter(([method]) => method === "logbook.status")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "logbook.timeline")).toHaveLength(2);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("shares the background refresh owner with analysis completion", async () => {
    const { request, resolve } = pendingRefresh("Resumed poll");
    const model = createModel(clientWithRequest(request));
    const state = model.state;
    await model.analyze();
    expect(request).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(3);

    resolve("Analysis refresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("Analysis refresh");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("keeps the replacement analysis locked until its own request settles", async () => {
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
      return Promise.resolve(timelineFor(state.day, "Current analysis"));
    });
    const newClient = clientWithRequest(request);
    const oldModel = createModel(oldClient);
    const oldRequest = oldModel.analyze();
    oldModel.dispose();
    const model = createModel(newClient);
    const state = model.state;
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
    const oldStatus = createDeferred<unknown>();
    const oldClient = clientWithRequest(() => oldStatus.promise);
    const newStatus = { ...statusFor("2026-07-05"), capturePaused: true };
    const newClient = clientWithRequest(() => Promise.resolve(newStatus));

    const oldModel = createModel(oldClient);
    const oldRequest = oldModel.setCapturePaused(true);
    oldModel.dispose();
    const model = createModel(newClient);
    const state = model.state;
    await model.setCapturePaused(true);
    expect(state.status).toEqual(newStatus);

    oldStatus.resolve(statusFor("2026-07-04"));
    await oldRequest;
    expect(state.status).toEqual(newStatus);
    expect(state.actionPending).toBe(false);
  });

  it("queues an analysis refresh behind an in-flight poll", async () => {
    const { request, resolve } = pendingRefresh("Post-analysis refresh");
    const model = createModel(clientWithRequest(request));
    const state = model.state;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);

    await model.analyze();
    expect(request).toHaveBeenCalledTimes(3);

    resolve("Pre-analysis refresh");
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(5);
    expect(state.timeline?.cards[0]?.title).toBe("Post-analysis refresh");
  });

  it("drops a queued analysis refresh when polling stops", async () => {
    const { request, resolve } = pendingRefresh();
    const model = createModel(clientWithRequest(request));
    const state = model.state;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    await model.analyze();
    expect(request).toHaveBeenCalledTimes(3);

    model.dispose();
    resolve("Detached host");
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(3);
    expect(state.timeline).toBeNull();
  });

  it("does not let an older day load overwrite a newer selection", async () => {
    const oldStatus = createDeferred<unknown>();
    const oldTimeline = createDeferred<unknown>();
    const oldResponses = new Map([
      ["logbook.status", oldStatus],
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
      return timelineFor("2026-07-05", "New day");
    });

    let read: (method: string, params: unknown) => Promise<unknown> = oldRequest;
    const model = createModel(clientWithRequest((method, params) => read(method, params)));
    const state = model.state;
    const olderLoad = model.load({ day: "2026-07-04" });
    expect(oldRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });

    read = newerRequest;
    await model.load({ day: "2026-07-05" });
    expect(newerRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-05" });
    expect(state.timeline?.cards[0]?.title).toBe("New day");

    oldStatus.resolve(statusFor("2026-07-04"));
    oldTimeline.resolve(timelineFor("2026-07-04", "Old day"));
    await olderLoad;

    expect(state.day).toBe("2026-07-05");
    expect(state.status?.today).toBe("2026-07-05");
    expect(state.timeline?.cards[0]?.title).toBe("New day");
    expect(state.loading).toBe(false);
  });

  it.each(["standup", "ask"] as const)(
    "discards a %s response after the selected day changes",
    async (action) => {
      const pending = createDeferred<unknown>();
      const client = clientWithRequest((method) => {
        if (method === "logbook.status") {
          return Promise.resolve(statusFor("2026-07-05"));
        }
        if (method === "logbook.timeline") {
          return Promise.resolve(timelineFor("2026-07-05", "Next day"));
        }
        return pending.promise;
      });
      const model = createModel(client);
      const state = model.state;
      const request = action === "standup" ? model.standup(false) : model.ask("What did I do?");

      await model.load({ day: "2026-07-05" });
      pending.resolve(
        action === "standup"
          ? { day: "2026-07-04", text: "Old day", updatedMs: 1 }
          : { answer: "Old day" },
      );
      await request;

      expect(action === "standup" ? state.standup : state.askAnswer).toBeNull();
    },
  );
});
