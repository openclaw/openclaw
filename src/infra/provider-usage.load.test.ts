// Covers provider usage summary loading across auth and plugin paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderResolveUsageAuthContext } from "../plugins/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageAuthWithPluginMock,
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import { loadUsageWithAuth, usageNow } from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const resolveProviderUsageAuthWithPluginMock = getProviderUsageAuthWithPluginMock();
const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
  });
  afterEach(() => vi.useRealTimers());

  it("does not dispatch auth or fetch for an exhausted budget", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue({ token: "fixture-token" });
    const result = await loadProviderUsageSummary({
      providers: ["anthropic"],
      config: {},
      env: { ANTHROPIC_API_KEY: "fixture-token" },
      now: usageNow,
      timeoutMs: 0,
      fetch,
    });
    expect(result).toEqual({
      updatedAt: usageNow,
      providers: [{ provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" }],
    });
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["init", false],
    ["request", true],
  ] as const)(
    "cancels the usage fetch (%s signal, caller abort: %s)",
    async (signalSource, callerAbort) => {
      vi.useFakeTimers();
      const scope = new AsyncWorkScope();
      const started = createDeferredCore();
      const response = createDeferredCore<Response>();
      const caller = new AbortController();
      const aborted = vi.fn();
      let fetchSignal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        fetchSignal?.addEventListener(
          "abort",
          () => {
            aborted();
            response.reject(fetchSignal?.reason);
          },
          { once: true },
        );
        started.resolve();
        return response.promise;
      });
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ context }) => {
        await (signalSource === "init"
          ? context.fetchFn("https://usage.example.test", { signal: caller.signal })
          : context.fetchFn(new Request("https://usage.example.test", { signal: caller.signal })));
        return { provider: "anthropic", displayName: "Claude", windows: [] };
      });
      const pending = scope.track(() =>
        loadProviderUsageSummary({
          auth: [{ provider: "anthropic", token: "fixture-token" }],
          config: {},
          env: {},
          timeoutMs: 1,
          fetch,
        }),
      );
      try {
        await started.promise;
        if (callerAbort) {
          caller.abort(new Error("Caller cancelled"));
        }
        await vi.advanceTimersByTimeAsync(callerAbort ? 0 : 1);
        expect(fetchSignal?.aborted).toBe(true);
        expect(aborted).toHaveBeenCalledOnce();
        expect(caller.signal.aborted).toBe(callerAbort);
        expect((await pending).providers).toEqual([
          {
            provider: "anthropic",
            displayName: "Claude",
            windows: [],
            error: callerAbort ? "Caller cancelled" : "Timeout",
          },
        ]);
        await scope.drain();
        expect(scope.hasPendingWork).toBe(false);
      } finally {
        response.resolve(new Response("{}"));
        await pending;
        await scope.drain();
      }
    },
  );

  it.each(["candidates", "oauth"])(
    "rejects a retained %s auth helper after the usage deadline",
    async (helper) => {
      vi.useFakeTimers();
      const scope = new AsyncWorkScope();
      const captured = createDeferredCore<ProviderResolveUsageAuthContext>();
      const release = createDeferredCore();
      resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ context }) => {
        captured.resolve(context);
        await release.promise;
        return { handled: true };
      });
      const pending = scope.track(() =>
        loadProviderUsageSummary({
          providers: ["anthropic"],
          config: {},
          env: { ANTHROPIC_API_KEY: "fixture-token" },
          timeoutMs: 1,
        }),
      );
      try {
        const context = await captured.promise;
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).providers[0]?.error).toBe("Timeout");
        expect(context.signal?.aborted).toBe(true);
        await expect(
          Promise.resolve().then(async () => {
            if (helper === "candidates") {
              await context.resolveApiKeyCandidatesFromConfigAndStore?.();
            } else {
              await context.resolveOAuthToken();
            }
          }),
        ).rejects.toBe(context.signal?.reason);
        expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        await scope.drain();
      }
    },
  );

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 500",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toStrictEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("keeps balance-only summary snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥42.50",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "deepseek", token: "token-d" }],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "deepseek",
        displayName: "DeepSeek",
        windows: [],
        summary: "Balance ¥42.50",
      },
    ]);
  });

  it("returns live siblings at the deadline while retaining the unfinished provider", async () => {
    vi.useFakeTimers();
    const scope = new AsyncWorkScope();
    const heldSnapshot = createDeferredCore<ProviderUsageSnapshot>();
    const lateSnapshot: ProviderUsageSnapshot = {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "5h", usedPercent: 20 }],
    };
    let summaryPromise: Promise<UsageSummary> | undefined;
    let draining: Promise<void> | undefined;
    try {
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => {
        if (provider === "anthropic") {
          return await heldSnapshot.promise;
        }
        return {
          provider,
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      });
      summaryPromise = scope.track(() =>
        loadProviderUsageSummary({
          auth: [
            { provider: "anthropic", token: "token-a" },
            { provider: "openai", token: "token-codex" },
          ],
          config: {},
          env: {},
          timeoutMs: 5_000,
        }),
      );
      let settled = false;
      void summaryPromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const settledAtDeadline = settled;
      if (!settledAtDeadline) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const summary = await summaryPromise;

      expect(settledAtDeadline).toBe(true);
      expect(summary.providers).toEqual([
        { provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" },
        {
          provider: "openai",
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        },
      ]);
      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      heldSnapshot.resolve(lateSnapshot);
      await draining;
      expect(drained).toBe(true);
      expect(summary.providers[0]?.error).toBe("Timeout");
    } finally {
      heldSnapshot.resolve(lateSnapshot);
      await Promise.allSettled([
        summaryPromise,
        ...resolveProviderUsageSnapshotWithPluginMock.mock.results.map((result) => result.value),
      ]);
      await (draining ?? scope.drain());
      vi.useRealTimers();
    }
  });

  it("keeps successful provider usage when a sibling auth hook rejects", async () => {
    resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ provider }) => {
      if (provider === "anthropic") {
        throw new Error("auth failed");
      }
      return { token: `${provider}-token` };
    });
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => ({
      provider,
      displayName: provider,
      windows: [{ label: "5h", usedPercent: 12 }],
    }));

    const summary = await loadProviderUsageSummary({
      providers: ["anthropic", "openai"],
      config: {},
      // Credential sources keep both providers past the plugin-auth gate so the
      // sibling-isolation behavior under test is actually exercised.
      env: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" },
    });

    expect(summary.providers).toEqual([
      { provider: "anthropic", displayName: "Claude", windows: [], error: "auth failed" },
      {
        provider: "openai",
        displayName: "openai",
        windows: [{ label: "5h", usedPercent: 12 }],
      },
    ]);
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          now: usageNow,
          auth: [{ provider: "xiaomi", token: "token-x" }],
          env: {},
          fetch: undefined,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
