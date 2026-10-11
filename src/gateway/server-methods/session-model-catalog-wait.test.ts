import { afterEach, expect, test, vi } from "vitest";
import { createSessionModelCatalogWait } from "./session-model-catalog-wait.js";

afterEach(() => vi.useRealTimers());

test.each(["deadline", "request", "connection", "authority"] as const)(
  "does not start another catalog read after the %s expires",
  async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const request = new AbortController();
    const connection = new AbortController();
    const authority = new AbortController();
    const wait = createSessionModelCatalogWait([request.signal, connection.signal]);
    await wait.run(async () => [], authority.signal);
    if (reason === "deadline") {
      await vi.advanceTimersByTimeAsync(20_000);
    } else {
      ({ request, connection, authority })[reason].abort();
    }
    const load = vi.fn(async () => []);
    await expect(wait.run(load, authority.signal)).rejects.toBe(wait.unavailable);
    expect(load).not.toHaveBeenCalled();
    expect(wait.unavailable.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  },
);
