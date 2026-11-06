import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { mockDocumentVisibility } from "../../test-helpers/mock-cleanup.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createLogbook } from "./logbook-state.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookClient, logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
const neverRetired = new Promise<void>(() => {});

function mountLogbook(request: Parameters<typeof logbookClient>[0]) {
  return mountSolid(() => (
    <Logbook initialClient={logbookClient(request)} getRetired={() => neverRetired} />
  ));
}

async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function dayResponse(method: string, day: string, title: string) {
  return method === "logbook.status" ? logbookStatus(day) : logbookTimeline(day, [{ title }], 1);
}

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("renders timeline clocks in the capture host timezone and preserves detail text", async () => {
  vi.spyOn(i18n, "getLocale").mockReturnValue("en");
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
  const { container } = mountLogbook(request);
  await waitForSolid(() => expect(container.querySelector(".logbook-card__header")).not.toBeNull());
  container.querySelector<HTMLButtonElement>(".logbook-card__header")!.click();
  flush();

  expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(
    "04:30 PM–05:30 PM",
  );
  expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
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
  const view = mountLogbook(request);
  await waitForSolid(() => expect(view.queryByRole("button", { name: "Pause" })).not.toBeNull());
  const toggle = view.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  const analyze = view.getByRole("button", { name: "Analyze now" });
  analyze.focus();

  serverStatus = { ...serverStatus, captureEnabled: true };
  await advance(30_000);
  expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
  expect(toggle.disabled).toBe(false);
  expect(document.activeElement).toBe(analyze);

  for (const paused of [true, false]) {
    toggle.click();
    await advance();
    expect(view.getByRole("button", { name: paused ? "Resume" : "Pause" })).toBe(toggle);
    expect(toggle.disabled).toBe(false);
  }

  serverStatus = { ...serverStatus, captureEnabled: false };
  await advance(30_000);
  expect(toggle.disabled).toBe(true);
});

function pendingRefresh(title?: string) {
  const pending = createDeferred<string>();
  const first = new Set(["logbook.status", "logbook.timeline"]);
  const request = vi.fn(async (method: string) => {
    if (method === "logbook.analyze.now") {
      return { started: true };
    }
    const current = first.delete(method) ? await pending.promise : title;
    if (current === undefined) {
      throw new Error(`Unexpected refresh request: ${method}`);
    }
    return dayResponse(method, "2026-07-04", current);
  });
  return { request, resolve: pending.resolve };
}

describe("Logbook request ownership", () => {
  const disposals: Array<() => void> = [];
  const createModel = (request: Parameters<typeof logbookClient>[0]) => {
    const model = createRoot((dispose) => {
      disposals.push(dispose);
      return Object.assign(createLogbook(logbookClient(request)), { dispose });
    });
    flush();
    return model;
  };
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 6, 4, 12).getTime() });
  });

  afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

  it("does not poll from a render discarded before settlement", () => {
    const request = vi.fn(async () => null);
    const dispose = createRoot((disposeRoot) => {
      disposals.push(disposeRoot);
      createLogbook(logbookClient(request));
      return disposeRoot;
    });
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
    dispose();
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
  });

  it("pauses background reads while hidden and catches up once on return", async () => {
    const show = mockDocumentVisibility("hidden");
    const request = vi.fn(async (method: string) =>
      method === "logbook.analyze.now"
        ? { started: true }
        : dayResponse(method, "2026-07-04", "Current timeline"),
    );
    const model = createModel(request);
    await advance(90_000);
    expect(request).not.toHaveBeenCalled();

    show("visible");
    await advance();
    expect(request).toHaveBeenCalledTimes(2);
    show("visible");
    await advance();
    expect(request).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(request).toHaveBeenCalledTimes(4);

    show("hidden");
    await advance(90_000);
    expect(request).toHaveBeenCalledTimes(4);
    await model.analyze();
    await advance();
    expect(request).toHaveBeenCalledTimes(7);
    expect(model.state.timeline?.cards[0]?.title).toBe("Current timeline");

    model.dispose();
    show("visible");
    await advance(30_000);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it.each(["analysis", "queued analysis", "disposed"] as const)(
    "serializes %s refreshes and admits only live results",
    async (mode) => {
      const { request, resolve } = pendingRefresh(mode === "disposed" ? undefined : "Resumed poll");
      const model = createModel(request);
      const state = model.state;
      if (mode !== "analysis") {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(request).toHaveBeenCalledTimes(2);
      }
      const analysis = model.analyze();
      expect(state.actionPending).toBe(true);
      await model.analyze();
      await analysis;
      expect(state.actionPending).toBe(false);
      expect(request).toHaveBeenCalledTimes(3);
      if (mode === "disposed") {
        model.dispose();
      }
      await vi.advanceTimersByTimeAsync(mode === "analysis" ? 60_000 : 0);
      expect(request).toHaveBeenCalledTimes(3);
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
      expect(request).toHaveBeenCalledTimes(5);
      expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
    },
  );

  it("discards a capture result after its polling owner retires", async () => {
    const pending = createDeferred<unknown>();
    const model = createModel(() => pending.promise);
    const request = model.setCapturePaused(true);
    model.dispose();
    pending.resolve(logbookStatus("2026-07-04"));
    await request;
    expect(model.state.status).toBeNull();
  });

  it.each(["standup", "ask"] as const)(
    "retires older reads and %s results when the day changes",
    async (action) => {
      const older = pendingRefresh();
      const pending = createDeferred<unknown>();
      let newer = false;
      const request = vi.fn((method: string) =>
        method === "logbook.standup" || method === "logbook.ask"
          ? pending.promise
          : newer
            ? Promise.resolve(dayResponse(method, "2026-07-05", "New day"))
            : older.request(method),
      );
      const model = createModel(request);
      const state = model.state;
      const read = model.load({ day: "2026-07-04" });
      const result = action === "standup" ? model.standup(false) : model.ask("What did I do?");
      expect(request).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });
      newer = true;
      await model.load({ day: "2026-07-05" });
      expect(request).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-05" });
      older.resolve("Old day");
      pending.resolve(
        action === "standup"
          ? { day: "2026-07-04", text: "Old day", updatedMs: 1 }
          : { answer: "Old day" },
      );
      await Promise.all([read, result]);
      expect(state.status?.today).toBe("2026-07-05");
      expect(state.timeline?.cards[0]?.title).toBe("New day");
      expect(state.loading).toBe(false);
      expect(action === "standup" ? state.standup : state.askAnswer).toBeNull();
    },
  );
});
