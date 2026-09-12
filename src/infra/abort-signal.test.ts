import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createAbortError,
  isAbortError,
  racePromiseWithAbortSignal,
  waitForAbortSignal,
} from "./abort-signal.js";

describe("abort errors", () => {
  it("creates a named error with an optional cause", () => {
    const cause = { source: "caller" };
    const error = createAbortError("stopped", { cause });

    expect(error).toMatchObject({ name: "AbortError", message: "stopped", cause });
  });

  it("detects standard and legacy Node abort errors", () => {
    expect(isAbortError(createAbortError("aborted"))).toBe(true);
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
    expect(isAbortError(new Error("This operation was aborted"))).toBe(true);
  });

  it.each([
    null,
    undefined,
    "string error",
    42,
    new Error("Operation aborted"),
    new Error("aborted"),
    new Error("Request was aborted"),
  ])("rejects non-abort input %#", (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe("waitForAbortSignal", () => {
  it("resolves immediately when signal is missing", async () => {
    await expect(waitForAbortSignal(undefined)).resolves.toBeUndefined();
  });

  it("resolves immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(waitForAbortSignal(abort.signal)).resolves.toBeUndefined();
  });

  it("waits until abort fires", async () => {
    const abort = new AbortController();
    let resolved = false;

    const task = waitForAbortSignal(abort.signal).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(resolved).toBe(true);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
});

describe("racePromiseWithAbortSignal", () => {
  it("preserves source settlement and removes the listener", async () => {
    const signal = new AbortController().signal;
    const sourceError = new Error("source failed");

    await expect(racePromiseWithAbortSignal(Promise.resolve("done"), signal)).resolves.toBe("done");
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    await expect(racePromiseWithAbortSignal(Promise.reject(sourceError), signal)).rejects.toBe(
      sourceError,
    );
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("rejects with the abort reason as cause without cancelling the source", async () => {
    const controller = new AbortController();
    let resolveSource!: (value: string) => void;
    const source = new Promise<string>((resolve) => {
      resolveSource = resolve;
    });
    const raced = racePromiseWithAbortSignal(source, controller.signal);
    const reason = new Error("caller stopped");

    controller.abort(reason);
    await expect(raced).rejects.toMatchObject({ name: "AbortError", cause: reason });
    resolveSource("still alive");
    await expect(source).resolves.toBe("still alive");
  });

  it("catches aborts that land while the listener is registered", async () => {
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      reason: "registration race",
      addEventListener: () => {
        aborted = true;
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    await expect(
      racePromiseWithAbortSignal(new Promise<never>(() => {}), signal),
    ).rejects.toMatchObject({ name: "AbortError", cause: "registration race" });
  });
});
