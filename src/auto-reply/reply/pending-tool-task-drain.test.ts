// Tests pending tool task drain ordering, settlement, and failure handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { logVerbose } from "../../globals.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("drainPendingToolTasks", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("settles empty drains without waiting for the idle deadline", async () => {
    vi.useFakeTimers();

    await drainPendingToolTasks({ tasks: new Set() });

    expect(logVerbose).not.toHaveBeenCalled();
  });

  it("resets the idle timeout after each completed task", async () => {
    vi.useFakeTimers();
    const first = createDeferred();
    const second = createDeferred();
    const tasks = new Set([first.promise, second.promise]);

    const drain = drainPendingToolTasks({ tasks });

    await vi.advanceTimersByTimeAsync(24_000);
    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(logVerbose).not.toHaveBeenCalled();

    second.resolve();
    await drain;
    expect(tasks.size).toBe(0);
    expect(logVerbose).not.toHaveBeenCalled();
  });

  it("drains tasks added after the initial snapshot", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const tasks = new Set([first.promise]);

    const drain = drainPendingToolTasks({ tasks });
    tasks.add(second.promise);
    first.resolve();
    await flushPromises();
    expect(tasks).toEqual(new Set([second.promise]));

    second.resolve();
    await drain;
    expect(tasks.size).toBe(0);
  });

  it("reports timeout when no pending task settles before the idle window", async () => {
    vi.useFakeTimers();
    const stuck = createDeferred();
    const tasks = new Set([stuck.promise]);

    const drain = drainPendingToolTasks({ tasks });
    await vi.advanceTimersByTimeAsync(30_000);

    await drain;
    expect(logVerbose).toHaveBeenCalledWith(
      "pending tool tasks made no progress within 30000ms; proceeding with 1 task(s) still pending to avoid session deadlock",
    );
    expect(tasks.size).toBe(1);
  });

  it("treats rejected tasks as drained progress", async () => {
    const failed = createDeferred();
    const later = createDeferred();
    const tasks = new Set([failed.promise, later.promise]);

    const drain = drainPendingToolTasks({ tasks });
    failed.reject(new Error("send failed"));
    await flushPromises();
    expect(tasks.size).toBe(1);
    later.resolve();

    await drain;
    expect(tasks.size).toBe(0);
  });
});
