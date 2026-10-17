import { expect, it, vi } from "vitest";
import { createUsageRequest } from "./request.ts";

it.each(["complete", "error"] as const)(
  "surfaces a failed %s publisher after releasing the pending request",
  async (outcome) => {
    const requestError = new Error("Usage request failed");
    const publicationError = new Error("Usage publication failed");
    const publish = vi.fn(() => {
      throw publicationError;
    });
    const notify = vi.fn();
    const request = createUsageRequest(notify, {
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
  const request = createUsageRequest(notify, {
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
