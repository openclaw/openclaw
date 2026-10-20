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

async function exhaustRetries(policy: UsageRefreshPolicy, connection?: object) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true, connection });
    await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
  }
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

  it.each([false, true])("defers hidden work until visible (interrupted: %s)", (interrupted) => {
    let loading = interrupted;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy(() => loading);
    policy.setLastLoadedAtMs(interrupted ? NOW_MS : NOW_MS - USAGE_PAYLOAD_TTL_MS);
    if (interrupted) {
      policy.interrupt();
      loading = false;
    }

    void policy.request("reconnect");
    expect(reload).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    void policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("restarts an exhausted retry budget for manual and focus cycles", async () => {
    const { policy, reload, onIncompleteUsageExhausted } = createPolicy();
    await exhaustRetries(policy);
    expect(reload).toHaveBeenCalledTimes(3);
    expect(policy.incompleteUsageExhausted).toBe(true);
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    expect(onIncompleteUsageExhausted).toHaveBeenCalledOnce();

    void policy.request("manual");
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(5);

    void policy.request("focus");
    policy.setLastLoadedAtMs(Date.now(), { incomplete: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(7);
  });

  it("replaces an exhausted retry budget when the connection changes", async () => {
    const { policy, reload } = createPolicy();
    const first = {};
    await exhaustRetries(policy, first);
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

  it.each(["poll", "focus"] as const)(
    "replays the highest-priority deferred reason: %s",
    async (reason) => {
      let loading = true;
      const { policy, reload } = createPolicy(() => loading);
      await policy.request("poll");
      if (reason === "focus") {
        await policy.request("focus");
        await policy.request("poll");
      }
      expect(reload).not.toHaveBeenCalled();
      loading = false;
      policy.flushPending();
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenLastCalledWith(reason);
    },
  );
});
