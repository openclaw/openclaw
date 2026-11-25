// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageRefreshPolicy } from "./refresh-policy.ts";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const NOW_MS = 1_000_000;

const reload = vi.fn(async () => undefined);
const onIncompleteUsageExhausted = vi.fn();
let policy: UsageRefreshPolicy;
let loading = false;

async function exhaustRetries() {
  policy.markProviderLoaded(null);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
    policy.markProviderLoaded(null);
  }
}

beforeEach(() => {
  loading = false;
  reload.mockClear();
  onIncompleteUsageExhausted.mockClear();
  policy = new UsageRefreshPolicy({
    isSessionLoading: () => loading,
    isProviderLoading: () => false,
    reload,
    onIncompleteUsageExhausted,
  });
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
  loading = interrupted;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  policy.markSessionsLoaded(interrupted ? NOW_MS : NOW_MS - USAGE_PAYLOAD_TTL_MS);
  policy.markProviderLoaded(NOW_MS);
  if (interrupted) {
    policy.interrupt();
    loading = false;
  }

  void policy.request("reconnect");
  expect(reload).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  void policy.request("focus");
  expect(reload).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenLastCalledWith({ sessions: true, provider: false });
});

it("refreshes an expired provider plan without rereading fresh sessions", async () => {
  policy.markSessionsLoaded(NOW_MS);
  policy.markProviderLoaded(NOW_MS - USAGE_PAYLOAD_TTL_MS);

  await policy.request("focus");

  expect(reload).toHaveBeenCalledExactlyOnceWith({ sessions: false, provider: true });
});

it.each(["manual", "focus", "reconnect"] as const)(
  "restarts an exhausted retry budget: %s",
  async (reset) => {
    await exhaustRetries();
    expect(reload).toHaveBeenCalledTimes(3);
    expect(policy.incompleteUsageExhausted).toBe(true);
    policy.markProviderLoaded(null);
    expect(onIncompleteUsageExhausted).toHaveBeenCalledOnce();
    await policy.request(reset);
    policy.markProviderLoaded(null);
    expect(policy.incompleteUsageExhausted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(5);
  },
);

it.each(["completion", "identity change", "disposal"] as const)(
  "cancels the previous retry timer on %s",
  async (reason) => {
    policy.markProviderLoaded(null);
    await vi.advanceTimersByTimeAsync(1_000);
    if (reason === "disposal") {
      policy.dispose();
    } else if (reason === "identity change") {
      policy.resetPayload();
    } else {
      policy.markProviderLoaded(Date.now());
    }
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "replays a provider poll without forcing a session read (publication: %s)",
  async (publication) => {
    loading = true;
    await policy.request("poll");
    if (publication) {
      await policy.request("publication");
    }
    expect(reload).not.toHaveBeenCalled();
    loading = false;
    await policy.flushPending();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenLastCalledWith({ sessions: publication, provider: true });
  },
);
