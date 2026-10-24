import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createLogbook } from "./logbook-state.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookClient, logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
const neverRetired = new Promise<void>(() => {});
const clientWithRequest = logbookClient;
const statusFor = logbookStatus;

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
});

describe("Logbook view", () => {
  it("renders timeline clocks in the capture host timezone and preserves detail text", async () => {
    const day = "2026-01-01";
    const status = logbookStatus(day, { timeZone: "America/Los_Angeles" });
    const timeline = logbookTimeline(day, [
      {
        startMs: Date.UTC(2026, 0, 2, 0, 30),
        endMs: Date.UTC(2026, 0, 2, 1, 30),
        detail: "  API_TOKEN = computeToken()  ",
      },
    ]);
    const request = vi.fn(async (method: string) =>
      structuredClone(method === "logbook.status" ? status : timeline),
    );
    const client = logbookClient(request);

    const { container } = mountSolid(() => (
      <Logbook initialClient={client} getRetired={() => neverRetired} />
    ));
    await waitForSolid(() =>
      expect(container.querySelector(".logbook-card__header")).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>(".logbook-card__header")!.click();
    flush();

    const timeOptions = {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    } satisfies Intl.DateTimeFormatOptions;
    const expectedTime = [Date.UTC(2026, 0, 2, 0, 30), Date.UTC(2026, 0, 2, 1, 30)]
      .map((ms) => new Date(ms).toLocaleTimeString(i18n.getLocale(), timeOptions))
      .join("–");
    expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(expectedTime);
    expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
    expect(container.querySelector(".logbook-card__detail")?.textContent).toBe(
      "API_TOKEN = computeToken()",
    );
    timeline.cards[0]!.title = "Refreshed work";
    container.querySelector<HTMLButtonElement>(".logbook__actions button:last-child")!.click();
    await waitForSolid(() =>
      expect(container.querySelector(".logbook-card__title")?.textContent).toBe("Refreshed work"),
    );
    expect(container.querySelector(".logbook-card__detail")?.textContent).toBe(
      "API_TOKEN = computeToken()",
    );
  });

  it("keeps action focus and capture toggle state current across refreshes", async () => {
    vi.useFakeTimers();
    const day = "2026-01-01";
    let serverStatus = logbookStatus(day, { captureEnabled: false, todayCards: 0 });
    const timeline = logbookTimeline(day);
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "logbook.capture.set") {
        serverStatus = { ...serverStatus, capturePaused: (params as { paused: boolean }).paused };
        return serverStatus;
      }
      if (method === "logbook.status") {
        return serverStatus;
      }
      if (method === "logbook.timeline") {
        return timeline;
      }
      throw new Error(`Unexpected Logbook request: ${method}`);
    });
    const client = logbookClient(request);
    const view = mountSolid(() => (
      <Logbook initialClient={client} getRetired={() => neverRetired} />
    ));
    await waitForSolid(() => expect(view.queryByRole("button", { name: "Pause" })).not.toBeNull());
    const toggle = view.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    const analyze = view.getByRole("button", { name: "Analyze now" });
    analyze.focus();
    expect(document.activeElement).toBe(analyze);

    serverStatus = { ...serverStatus, captureEnabled: true };
    await vi.advanceTimersByTimeAsync(30_000);
    flush();
    expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
    expect(toggle.disabled).toBe(false);
    expect(view.getByRole("button", { name: "Analyze now" })).toBe(analyze);
    expect(document.activeElement).toBe(analyze);

    toggle.click();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("button", { name: "Resume" })).toBe(toggle);
    expect(toggle.disabled).toBe(false);
    expect(request).toHaveBeenCalledWith("logbook.capture.set", { paused: true });

    toggle.click();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
    expect(request).toHaveBeenCalledWith("logbook.capture.set", { paused: false });

    serverStatus = { ...serverStatus, captureEnabled: false };
    await vi.advanceTimersByTimeAsync(30_000);
    flush();
    expect(toggle.disabled).toBe(true);
  });
});

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
    resolve: (settledTitle: string) => {
      status.resolve(statusFor("2026-07-04"));
      timeline.resolve(timelineFor("2026-07-04", settledTitle));
    },
  };
}

describe("Logbook request ownership", () => {
  const disposals: Array<() => void> = [];
  const createModel = (client: GatewayBrowserClient) => {
    const model = createRoot((dispose) => {
      disposals.push(dispose);
      return Object.assign(createLogbook(client), { dispose });
    });
    flush();
    return model;
  };
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

  it("does not poll from a render discarded before settlement", () => {
    const request = vi.fn(async () => null);
    const dispose = createRoot((disposeRoot) => {
      disposals.push(disposeRoot);
      createLogbook(clientWithRequest(request));
      return disposeRoot;
    });
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
    dispose();
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["poll", "analysis", "queued analysis", "disposed"] as const)(
    "serializes %s refreshes and admits only live results",
    async (mode) => {
      const { request, resolve } = pendingRefresh(mode === "disposed" ? undefined : "Resumed poll");
      const model = createModel(clientWithRequest(request));
      const state = model.state;
      if (mode === "analysis") {
        await model.analyze();
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(request).toHaveBeenCalledTimes(2);
      }
      if (mode === "queued analysis" || mode === "disposed") {
        await model.analyze();
      }
      const initialCalls = mode === "poll" ? 2 : 3;
      expect(request).toHaveBeenCalledTimes(initialCalls);
      if (mode === "disposed") {
        model.dispose();
      }
      await vi.advanceTimersByTimeAsync(
        mode === "poll" ? 90_000 : mode === "analysis" ? 60_000 : 0,
      );
      expect(request).toHaveBeenCalledTimes(initialCalls);
      resolve("First refresh");
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "disposed") {
        expect(request).toHaveBeenCalledTimes(3);
        expect(state.timeline).toBeNull();
        return;
      }
      if (mode !== "queued analysis") {
        expect(state.timeline?.cards[0]?.title).toBe("First refresh");
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(request).toHaveBeenCalledTimes(initialCalls + 2);
      expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
      if (mode === "poll") {
        expect(request.mock.calls.filter(([method]) => method === "logbook.status")).toHaveLength(
          2,
        );
        expect(request.mock.calls.filter(([method]) => method === "logbook.timeline")).toHaveLength(
          2,
        );
      }
    },
  );

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

  it("does not let an older day load overwrite a newer selection", async () => {
    const { request: oldRequest, resolve } = pendingRefresh();
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

    resolve("Old day");
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
