import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test,
  loadSessionLogs,
  loadSessionTimeSeries,
  loadUsage,
  resetSessionUsageDetails,
  type UsageState,
} from "./usage.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<UsageState> = {}): UsageState {
  return {
    client: { request } as unknown as UsageState["client"],
    connected: true,
    usageLoading: false,
    usageRequestVersion: 0,
    usageResult: null,
    usageCostSummary: null,
    usageError: null,
    usageStartDate: "2026-02-16",
    usageEndDate: "2026-02-16",
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageTimeSeries: null,
    usageTimeSeriesLoading: false,
    usageTimeSeriesRequestVersion: 0,
    usageTimeSeriesCursorStart: null,
    usageTimeSeriesCursorEnd: null,
    usageSessionLogs: null,
    usageSessionLogsLoading: false,
    usageSessionLogsRequestVersion: 0,
    usageTimeZone: "local",
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockLocalTimeZoneName(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions);
}

function expectSpecificTimezoneCalls(request: ReturnType<typeof vi.fn>, startCall: number): void {
  const utcOffset = __test.formatUtcOffset(new Date().getTimezoneOffset());
  const localTimeZoneName = __test.resolveLocalTimeZoneName();
  const dateInterpretation = localTimeZoneName
    ? {
        mode: "specific" as const,
        timeZone: localTimeZoneName,
        utcOffset,
      }
    : {
        mode: "specific" as const,
        utcOffset,
      };
  expect(request).toHaveBeenNthCalledWith(startCall, "sessions.usage", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    ...dateInterpretation,
    limit: 1000,
    includeContextWeight: true,
  });
  expect(request).toHaveBeenNthCalledWith(startCall + 1, "usage.cost", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    ...dateInterpretation,
  });
}

function expectOffsetOnlyCalls(
  request: ReturnType<typeof vi.fn>,
  startCall: number,
  utcOffset: string,
): void {
  expect(request).toHaveBeenNthCalledWith(startCall, "sessions.usage", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "specific",
    utcOffset,
    limit: 1000,
    includeContextWeight: true,
  });
  expect(request).toHaveBeenNthCalledWith(startCall + 1, "usage.cost", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "specific",
    utcOffset,
  });
}

function expectUtcCalls(request: ReturnType<typeof vi.fn>, startCall: number): void {
  expect(request).toHaveBeenNthCalledWith(startCall, "sessions.usage", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "utc",
    limit: 1000,
    includeContextWeight: true,
  });
  expect(request).toHaveBeenNthCalledWith(startCall + 1, "usage.cost", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "utc",
  });
}

function expectLegacyUtcCalls(request: ReturnType<typeof vi.fn>, startCall: number): void {
  expect(request).toHaveBeenNthCalledWith(startCall, "sessions.usage", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    limit: 1000,
    includeContextWeight: true,
  });
  expect(request).toHaveBeenNthCalledWith(startCall + 1, "usage.cost", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
  });
}

describe("usage controller date interpretation params", () => {
  beforeEach(() => {
    __test.resetLegacyUsageDateParamsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats UTC offsets for whole and half-hour timezones", () => {
    expect(__test.formatUtcOffset(240)).toBe("UTC-4");
    expect(__test.formatUtcOffset(-330)).toBe("UTC+5:30");
    expect(__test.formatUtcOffset(0)).toBe("UTC+0");
  });

  it("sends specific mode with browser offset when usage timezone is local", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request, { usageTimeZone: "local" });
    mockLocalTimeZoneName("Asia/Kolkata");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
  });

  it("sends utc mode without offset when usage timezone is utc", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request, { usageTimeZone: "utc" });

    await loadUsage(state);

    expectUtcCalls(request, 1);
  });

  it("captures useful error strings in loadUsage", async () => {
    const request = vi.fn(async () => {
      throw new Error("request failed");
    });
    const state = createState(request);

    await loadUsage(state);

    expect(state.usageError).toBe("request failed");
  });

  it("serializes non-Error objects without object-to-string coercion", () => {
    expect(__test.toErrorMessage({ reason: "nope" })).toBe('{"reason":"nope"}');
  });

  it("fails loudly and remembers compatibility when local mode hits a legacy gateway", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    mockLocalTimeZoneName("Asia/Kolkata");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("mode" in record || "timeZone" in record || "utcOffset" in record) {
          throw new Error(
            "invalid sessions.usage params: at root: unexpected property 'mode'; at root: unexpected property 'utcOffset'",
          );
        }
        return { sessions: [] };
      }
      return {};
    });

    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.usageTimeZone).toBe("local");
    expect(state.usageError).toContain("too old to support Usage time zone filters");

    // Subsequent loads for the same gateway should fail immediately without sending requests.
    await loadUsage(state);

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.usageError).toContain("too old to support Usage time zone filters");

    // Persisted flag should survive cache resets (simulating app reload).
    __test.resetLegacyUsageDateParamsCache();
    expect(__test.shouldSendLegacyDateInterpretation(state)).toBe(false);

    vi.unstubAllGlobals();
  });

  it("retries local mode with utcOffset when the gateway rejects only timeZone", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    mockLocalTimeZoneName("Asia/Kolkata");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);
    const localTimeZoneName = __test.resolveLocalTimeZoneName();
    const fallbackUtcOffset = localTimeZoneName
      ? __test.resolveFixedUtcOffsetForRange("2026-02-16", "2026-02-16", localTimeZoneName)
      : undefined;

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("timeZone" in record) {
          throw new Error("invalid sessions.usage params: at root: unexpected property 'timeZone'");
        }
        return { sessions: [{ key: "offset-only" }] };
      }
      return { daily: [], totals: { totalTokens: 3 } };
    });

    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
    expectOffsetOnlyCalls(
      request,
      3,
      fallbackUtcOffset ?? __test.formatUtcOffset(new Date().getTimezoneOffset()),
    );
    expect(request).toHaveBeenCalledTimes(4);
    expect(state.usageError).toBeNull();
    expect(state.usageResult).toEqual({ sessions: [{ key: "offset-only" }] });
    expect(state.usageCostSummary).toEqual({ daily: [], totals: { totalTokens: 3 } });

    vi.unstubAllGlobals();
  });

  it("retries local mode with timeZone again after a gateway upgrades", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    mockLocalTimeZoneName("Asia/Kolkata");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    let supportsTimeZone = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      const record = (params ?? {}) as Record<string, unknown>;
      if (method === "sessions.usage") {
        if ("timeZone" in record && !supportsTimeZone) {
          throw new Error("invalid sessions.usage params: at root: unexpected property 'timeZone'");
        }
        return { sessions: [{ key: supportsTimeZone ? "time-zone" : "offset-only" }] };
      }
      return { daily: [], totals: { totalTokens: supportsTimeZone ? 8 : 3 } };
    });

    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    supportsTimeZone = true;
    await loadUsage(state);

    expect(request).toHaveBeenCalledTimes(6);
    expectSpecificTimezoneCalls(request, 5);
    expect(state.usageError).toBeNull();
    expect(state.usageResult).toEqual({ sessions: [{ key: "time-zone" }] });
    expect(state.usageCostSummary).toEqual({ daily: [], totals: { totalTokens: 8 } });

    vi.unstubAllGlobals();
  });

  it("marks DST-crossing ranges as unsafe for offset-only fallback", () => {
    expect(
      __test.resolveFixedUtcOffsetForRange("2026-03-08", "2026-03-09", "America/New_York"),
    ).toBeUndefined();
  });

  it("fails loudly instead of retrying offset-only across a DST transition", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    mockLocalTimeZoneName("America/New_York");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(240);

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("timeZone" in record) {
          throw new Error("invalid sessions.usage params: at root: unexpected property 'timeZone'");
        }
        return { sessions: [{ key: "should-not-retry" }] };
      }
      return { daily: [], totals: { totalTokens: 5 } };
    });

    const state = createState(request, {
      usageTimeZone: "local",
      usageStartDate: "2026-03-08",
      usageEndDate: "2026-03-08",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.usageResult).toBeNull();
    expect(state.usageCostSummary).toBeNull();
    expect(state.usageError).toContain("too old to support Usage time zone filters");

    vi.unstubAllGlobals();
  });

  it("retries once without date interpretation when utc mode hits a legacy gateway", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("mode" in record || "timeZone" in record || "utcOffset" in record) {
          throw new Error("invalid sessions.usage params: at root: unexpected property 'mode'");
        }
        return { sessions: [{ key: "legacy-ok" }] };
      }
      return { daily: [], totals: { totalTokens: 1 } };
    });
    const state = createState(request, {
      usageTimeZone: "utc",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expectUtcCalls(request, 1);
    expectLegacyUtcCalls(request, 3);
    expect(request).toHaveBeenCalledTimes(4);
    expect(state.usageError).toBeNull();
    expect(state.usageResult).toEqual({ sessions: [{ key: "legacy-ok" }] });
    expect(state.usageCostSummary).toEqual({ daily: [], totals: { totalTokens: 1 } });
    expect(__test.shouldSendLegacyDateInterpretation(state)).toBe(false);

    vi.unstubAllGlobals();
  });

  it("skips date interpretation params for utc mode when the gateway is already known to be legacy", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);

    const request = vi.fn(async (method: string) => {
      return method === "sessions.usage"
        ? { sessions: [{ key: "legacy-cached" }] }
        : { daily: [], totals: { totalTokens: 2 } };
    });
    const state = createState(request, {
      usageTimeZone: "utc",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });
    __test.rememberLegacyDateInterpretation(state);

    await loadUsage(state);

    expectLegacyUtcCalls(request, 1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.usageError).toBeNull();
    expect(state.usageResult).toEqual({ sessions: [{ key: "legacy-cached" }] });
    expect(state.usageCostSummary).toEqual({ daily: [], totals: { totalTokens: 2 } });

    vi.unstubAllGlobals();
  });

  it("fails immediately for local mode when a gateway is already known to reject date interpretation params", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);

    const request = vi.fn(async () => ({}));
    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });
    __test.rememberLegacyDateInterpretation(state);
    state.usageTimeZone = "local";

    await loadUsage(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.usageTimeZone).toBe("local");
    expect(state.usageError).toContain("too old to support Usage time zone filters");

    vi.unstubAllGlobals();
  });
});

describe("usage loading", () => {
  it("keeps only the latest usage results when a new range is requested mid-flight", async () => {
    const firstSessions = createDeferred<unknown>();
    const firstCost = createDeferred<unknown>();
    const secondSessions = createDeferred<unknown>();
    const secondCost = createDeferred<unknown>();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async (method, params) => {
        const startDate = (params as { startDate?: string } | undefined)?.startDate;
        if (startDate === "2026-02-17") {
          return method === "sessions.usage" ? secondSessions.promise : secondCost.promise;
        }
        return method === "sessions.usage" ? firstSessions.promise : firstCost.promise;
      },
    );
    const state = createState(request);
    const latestUsageResult = {
      sessions: [{ key: "latest" }],
      aggregates: { messages: { total: 1 } },
    };
    const latestCostSummary = { daily: [], totals: { totalTokens: 2 } };

    const firstLoad = loadUsage(state, {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
    });
    const secondLoad = loadUsage(state, {
      startDate: "2026-02-17",
      endDate: "2026-02-17",
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(state.usageLoading).toBe(true);

    secondSessions.resolve(latestUsageResult);
    secondCost.resolve(latestCostSummary);
    await secondLoad;

    expect(state.usageResult).toEqual(latestUsageResult);
    expect(state.usageCostSummary).toEqual(latestCostSummary);
    expect(state.usageLoading).toBe(false);

    firstSessions.resolve({
      sessions: [{ key: "stale" }],
      aggregates: { messages: { total: 99 } },
    });
    firstCost.resolve({ daily: [], totals: { totalTokens: 999 } });
    await firstLoad;

    expect(state.usageResult).toEqual(latestUsageResult);
    expect(state.usageCostSummary).toEqual(latestCostSummary);
    expect(state.usageLoading).toBe(false);
  });

  it("clears stale usage data when the active request fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("request failed");
    });
    const state = createState(request, {
      usageResult: {
        sessions: [{ key: "stale" }],
        aggregates: { messages: { total: 9 } },
      } as never,
      usageCostSummary: { daily: [], totals: { totalTokens: 99 } } as never,
    });

    await loadUsage(state);

    expect(state.usageResult).toBeNull();
    expect(state.usageCostSummary).toBeNull();
    expect(state.usageError).toBe("request failed");
  });
});

describe("usage detail loading", () => {
  it("keeps only the latest time series response when session selection changes quickly", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const state = createState(request);

    const firstLoad = loadSessionTimeSeries(state, "session-a");
    const secondLoad = loadSessionTimeSeries(state, "session-b");

    second.resolve({ points: [{ timestamp: 2 }] });
    await secondLoad;

    expect(state.usageTimeSeries).toEqual({ points: [{ timestamp: 2 }] });
    expect(state.usageTimeSeriesLoading).toBe(false);

    first.resolve({ points: [{ timestamp: 1 }] });
    await firstLoad;

    expect(state.usageTimeSeries).toEqual({ points: [{ timestamp: 2 }] });
    expect(state.usageTimeSeriesLoading).toBe(false);
  });

  it("keeps only the latest session logs response when session selection changes quickly", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const state = createState(request);

    const firstLoad = loadSessionLogs(state, "session-a");
    const secondLoad = loadSessionLogs(state, "session-b");

    second.resolve({ logs: [{ timestamp: 2, role: "assistant", content: "latest" }] });
    await secondLoad;

    expect(state.usageSessionLogs).toEqual([
      { timestamp: 2, role: "assistant", content: "latest" },
    ]);
    expect(state.usageSessionLogsLoading).toBe(false);

    first.resolve({ logs: [{ timestamp: 1, role: "user", content: "stale" }] });
    await firstLoad;

    expect(state.usageSessionLogs).toEqual([
      { timestamp: 2, role: "assistant", content: "latest" },
    ]);
    expect(state.usageSessionLogsLoading).toBe(false);
  });

  it("invalidates in-flight detail requests when the selection is cleared", async () => {
    const deferred = createDeferred<unknown>();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => deferred.promise,
    );
    const state = createState(request);

    const pending = loadSessionLogs(state, "session-a");
    resetSessionUsageDetails(state);
    deferred.resolve({ logs: [{ timestamp: 1, role: "user", content: "stale" }] });
    await pending;

    expect(state.usageSessionLogs).toBeNull();
    expect(state.usageSessionLogsLoading).toBe(false);
  });

  it("reinitializes request versions when state-like objects start uninitialized", () => {
    const state = createState(
      vi.fn(async () => ({})),
      {
        usageTimeSeriesRequestVersion: Number.NaN,
        usageSessionLogsRequestVersion: Number.NaN,
      },
    );

    resetSessionUsageDetails(state);

    expect(state.usageTimeSeriesRequestVersion).toBe(1);
    expect(state.usageSessionLogsRequestVersion).toBe(1);
  });
});

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
