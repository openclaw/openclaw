import { expect, it, vi } from "vitest";
import { createPageRequest } from "./page-request.ts";

it.each(["complete", "error"] as const)(
  "surfaces a failed %s publisher after releasing the pending request",
  async (outcome) => {
    const requestError = new Error("Usage request failed");
    const publicationError = new Error("Usage publication failed");
    const publish = vi.fn(() => {
      throw publicationError;
    });
    const notify = vi.fn();
    const request = createPageRequest(notify, {
      task: async () => {
        if (outcome === "error") {
          throw requestError;
        }
        return "usage";
      },
      onComplete: publish,
      onError: publish,
    });

    const pending = request.run(undefined);
    expect(request.pending).toBe(true);
    await expect(pending).rejects.toBe(publicationError);
    expect(publish).toHaveBeenCalledExactlyOnceWith(outcome === "error" ? requestError : "usage");
    expect(request.pending).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
  },
);

it("presents an ordinary request failure through the error publisher", async () => {
  const requestError = new Error("Usage request failed");
  const notify = vi.fn();
  const onComplete = vi.fn();
  const onError = vi.fn();
  const request = createPageRequest(notify, {
    task: async () => {
      throw requestError;
    },
    onComplete,
    onError,
  });

  await expect(request.run(undefined)).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledExactlyOnceWith(requestError);
  expect(onComplete).not.toHaveBeenCalled();
  expect(request.pending).toBe(false);
  expect(notify).toHaveBeenCalledTimes(2);
});

it.each(["complete", "error"] as const)(
  "does not publish a superseded %s or release its successor",
  async (outcome) => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const signals: AbortSignal[] = [];
    const onComplete = vi.fn();
    const onError = vi.fn();
    const request = createPageRequest(vi.fn(), {
      task: (value: Promise<string>, { signal }) => {
        signals.push(signal);
        return value;
      },
      onComplete,
      onError,
    });
    const retired = request.run(first.promise);
    const latest = request.run(second.promise);
    expect(signals[0]?.aborted).toBe(true);
    if (outcome === "error") {
      first.reject(new Error("retired"));
    } else {
      first.resolve("retired");
    }
    await retired;
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(request.pending).toBe(true);
    second.resolve("latest");
    await latest;
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("latest");
    expect(request.pending).toBe(false);
  },
);

it("keeps a successor started by the completion publisher pending", async () => {
  const next = Promise.withResolvers<string>();
  let successor: Promise<void> | undefined;
  const values: string[] = [];
  const request = createPageRequest(vi.fn(), {
    task: (value: Promise<string>) => value,
    onComplete: (value) => {
      values.push(value);
      if (value === "first") {
        successor = request.run(next.promise);
      }
    },
    onError: (error) => {
      throw error;
    },
  });
  await request.run(Promise.resolve("first"));
  expect(request.pending).toBe(true);
  next.resolve("second");
  await successor;
  expect(values).toEqual(["first", "second"]);
  expect(request.pending).toBe(false);
});
