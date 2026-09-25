import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAbortError,
  isAbortError,
  racePromiseWithAbortSignal,
  raceWithAbortRelease,
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
    expect(
      isAbortError({
        name: "AbortError",
        get message() {
          throw new Error("Abort metadata is unavailable");
        },
      }),
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    "string error",
    42,
    new Error("Operation aborted"),
    new Error("aborted"),
    new Error("Request was aborted"),
    ...(["name", "message"] as const).map((field) =>
      Object.defineProperty(new Error("Metadata is unavailable"), field, {
        get() {
          throw new Error("Error metadata is unavailable");
        },
      }),
    ),
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

  it("leaves no listener when a racing caller abandons the wait", async () => {
    const abort = new AbortController();
    const aborted = waitForAbortSignal(abort.signal);

    // Mirrors production races such as main-session restart recovery: the other
    // source wins while the signal stays un-aborted for the life of the process.
    await Promise.race([Promise.resolve("other source won"), aborted]);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(1);

    aborted.release();
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("tolerates release after the signal already aborted", async () => {
    const abort = new AbortController();
    const aborted = waitForAbortSignal(abort.signal);

    abort.abort();
    await aborted;
    aborted.release();
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("reports release as a no-op without a signal", () => {
    expect(() => waitForAbortSignal(undefined).release()).not.toThrow();
  });
});

describe("raceWithAbortRelease", () => {
  it("returns the source result and leaves no listener when the source wins", async () => {
    const abort = new AbortController();
    const result = await raceWithAbortRelease(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("source won"), 5);
      }),
      abort.signal,
    );

    expect(result).toBe("source won");
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("resolves undefined on abort and still removes the listener", async () => {
    const abort = new AbortController();
    const pending = raceWithAbortRelease(new Promise<never>(() => {}), abort.signal);

    abort.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
});

describe("racePromiseWithAbortSignal", () => {
  it.each(["rejected", "pending", "fulfilled"] as const)(
    "observes a %s source when an existing abort wins",
    async (state) => {
      const controller = new AbortController();
      const reason = new Error("already stopped");
      controller.abort(reason);
      const deferred = createDeferred<string>();
      const sourceError = new Error("source failed");
      const source =
        state === "rejected"
          ? Promise.reject(sourceError)
          : state === "fulfilled"
            ? Promise.resolve("done")
            : deferred.promise;

      await expect(racePromiseWithAbortSignal(source, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
        cause: reason,
      });
      if (state === "pending") {
        deferred.reject(sourceError);
      }
      // Let Node report an unobserved rejection before this regression finishes.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("observes a later source rejection after an active signal aborts", async () => {
    const controller = new AbortController();
    const source = createDeferred<string>();
    const raced = racePromiseWithAbortSignal(source.promise, controller.signal);
    controller.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
    source.reject(new Error("late source failure"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("returns the source unchanged when no signal is supplied", async () => {
    const source = Promise.resolve("done");
    expect(racePromiseWithAbortSignal(source)).toBe(source);
    await expect(source).resolves.toBe("done");
    const failure = new Error("source failed");
    await expect(racePromiseWithAbortSignal(Promise.reject(failure))).rejects.toBe(failure);
  });

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
    const { promise: source, resolve: resolveSource } = createDeferred<string>();
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
