// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageRefreshPolicy } from "./refresh-policy.ts";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const NOW_MS = 1_000_000;

function createPolicy(isLoading = () => false) {
  const reload = vi.fn(async () => undefined);
  const onIncompleteUsageExhausted = vi.fn();
  return {
    policy: new UsageRefreshPolicy({ isLoading, reload, onIncompleteUsageExhausted }),
    reload,
    onIncompleteUsageExhausted,
  };
}

describe("UsageRefreshPolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips automatic refresh while the cached payload is within the TTL", () => {
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS - USAGE_PAYLOAD_TTL_MS + 1);

    policy.request("reconnect");
    policy.request("poll");

    expect(reload).not.toHaveBeenCalled();
  });

  it("defers stale work until the page is visible", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS - USAGE_PAYLOAD_TTL_MS);

    policy.request("reconnect");
    expect(reload).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("always fetches for a manual refresh", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS);

    policy.request("manual");

    expect(reload).toHaveBeenCalledOnce();
  });

  it("retries interrupted work once active despite a fresh payload", () => {
    let loading = true;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy(() => loading);
    policy.setLastLoadedAtMs(NOW_MS);
    policy.interrupt();
    loading = false;

    policy.request("reconnect");
    expect(reload).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("restarts an exhausted retry budget for manual and focus cycles", async () => {
    const { policy, reload, onIncompleteUsageExhausted } = createPolicy();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
      await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
    }
    expect(reload).toHaveBeenCalledTimes(3);
    expect(policy.incompleteUsageExhausted).toBe(true);
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    expect(onIncompleteUsageExhausted).toHaveBeenCalledOnce();

    policy.request("manual");
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(5);

    policy.request("focus");
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(7);
  });

  it("replaces an exhausted retry budget when the connection changes", async () => {
    const { policy, reload } = createPolicy();
    const first = {};
    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.setLastLoadedAtMs(Date.now(), { incomplete: true, connection: first });
      await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
    }
    expect(reload).toHaveBeenCalledTimes(3);
    expect(policy.incompleteUsageExhausted).toBe(true);

    policy.setLastLoadedAtMs(Date.now(), { incomplete: true, connection: {} });
    expect(policy.incompleteUsageExhausted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it.each(["completion", "connection", "disposal"] as const)(
    "cancels the previous retry timer on %s",
    async (reason) => {
      const { policy, reload } = createPolicy();
      const connection = {};
      policy.setLastLoadedAtMs(Date.now(), { incomplete: true, connection });
      await vi.advanceTimersByTimeAsync(1_000);
      if (reason === "disposal") {
        policy.dispose();
      } else {
        policy.setLastLoadedAtMs(Date.now(), {
          incomplete: reason === "connection",
          connection: reason === "connection" ? {} : connection,
        });
      }
      await vi.advanceTimersByTimeAsync(4_000);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).toHaveBeenCalledTimes(reason === "connection" ? 1 : 0);
    },
  );
});
