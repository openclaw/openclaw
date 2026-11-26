import { expect, it, vi } from "vitest";
import { createPageRequest } from "./page-request.ts";

function fixture(complete?: (value: string) => void, error?: (error: unknown) => void) {
  const onComplete = vi.fn(complete),
    onError = vi.fn(error),
    notify = vi.fn();
  const task = vi.fn((value: Promise<string>, _options: { signal: AbortSignal }) => value);
  const request = createPageRequest(notify, { task, onComplete, onError });
  return { request, notify, task, onComplete, onError };
}

it.each([
  ["complete", true],
  ["error", true],
  ["error", false],
] as const)("settles %s requests when publisher throws=%s", async (outcome, throws) => {
  const requestError = new Error("Usage request failed");
  const publicationError = new Error("Usage publication failed");
  const fail = () => {
    throw publicationError;
  };
  const publish = throws ? fail : undefined;
  const { request, notify, onComplete, onError } = fixture(publish, publish);
  const pending = request.run(
    outcome === "error" ? Promise.reject(requestError) : Promise.resolve("usage"),
  );
  expect(request.pending).toBe(true);
  await (throws
    ? expect(pending).rejects.toBe(publicationError)
    : expect(pending).resolves.toBeUndefined());
  expect(outcome === "error" ? onError : onComplete).toHaveBeenCalledExactlyOnceWith(
    outcome === "error" ? requestError : "usage",
  );
  expect(outcome === "error" ? onComplete : onError).not.toHaveBeenCalled();
  expect(request.pending).toBe(false);
  expect(notify).toHaveBeenCalledTimes(2);
});

it.each(["complete", "error"] as const)(
  "ignores superseded %s without releasing its successor",
  async (outcome) => {
    const first = Promise.withResolvers<string>(),
      second = Promise.withResolvers<string>();
    const { request, task, onComplete, onError } = fixture();
    const retired = request.run(first.promise),
      latest = request.run(second.promise);
    expect(task.mock.calls[0]?.[1].signal.aborted).toBe(true);
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
  const { request, onComplete } = fixture((value) => {
    if (value === "first") {
      successor = request.run(next.promise);
    }
  });
  await request.run(Promise.resolve("first"));
  expect(request.pending).toBe(true);
  next.resolve("second");
  await successor;
  expect(onComplete.mock.calls).toEqual([["first"], ["second"]]);
  expect(request.pending).toBe(false);
});
