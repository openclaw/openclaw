// Covers provider usage summary loading across auth and plugin paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveUsageAuthContext } from "../plugins/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import { fetchWithSsrFGuard } from "./net/fetch-guard.js";
import { withGuardedFetchBeforeRequest } from "./net/fetch-request-authority.js";
import {
  getProviderUsageAuthWithPluginMock,
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);
const resolveProviderUsageAuthWithPluginMock = getProviderUsageAuthWithPluginMock();
const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();
const claude: ProviderUsageSnapshot = { provider: "anthropic", displayName: "Claude", windows: [] };
const codex: ProviderUsageSnapshot = {
  provider: "openai",
  displayName: "Codex",
  windows: [{ label: "3h", usedPercent: 12 }],
};
const load = (options: Parameters<typeof loadProviderUsageSummary>[0]) =>
  loadProviderUsageSummary({ config: {}, env: {}, ...options });
const unusedFetch = () =>
  createProviderUsageFetch(async () => {
    throw new Error("legacy fetch should not run");
  });

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
  });
  afterEach(() => vi.useRealTimers());

  it.each(["unchanged", "removed", "replaced"])(
    "checks %s managed authority after resolution at guarded HTTP dispatch",
    async (change) => {
      const source: OpenClawConfig = {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://usage.example.test",
              models: [],
              apiKey: { source: "exec", provider: "default", id: "usage" },
            },
          },
        },
      };
      const prepared = structuredClone(source);
      prepared.models!.providers!.openrouter!.apiKey = "managed-usage-key";
      setRuntimeConfigSnapshot(prepared, source);
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ context }) => {
        const token = (await context.resolveApiKeyCandidatesFromConfigAndStore?.())?.[0];
        return token ? { token } : undefined;
      });
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ context }) => {
        expect(context.token).toBe("managed-usage-key");
        // Configured provider transports can bypass context.fetchFn. They still
        // use the shared guarded dispatch after asynchronous DNS preparation.
        const result = await fetchWithSsrFGuard({
          url: "https://usage.example.test/quota",
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: globalThis.fetch,
          init: { headers: { Authorization: `Bearer ${context.token}` } },
        });
        await result.release();
        return { provider: "openrouter", displayName: "OpenRouter", windows: [] };
      });
      let dispatchChecks = 0;
      try {
        const summary = await withGuardedFetchBeforeRequest(
          () => {
            dispatchChecks += 1;
            if (change === "removed") {
              clearRuntimeConfigSnapshot();
            }
            if (change === "replaced") {
              const replacement = structuredClone(prepared);
              replacement.models!.providers!.openrouter!.apiKey = "replacement-key";
              setRuntimeConfigSnapshot(replacement, source);
            }
          },
          () =>
            load({
              providers: ["openrouter"],
              config: prepared,
              authStore: { version: 1, profiles: {} },
            }),
        );
        expect(dispatchChecks).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
        if (change !== "unchanged") {
          expect(summary.providers[0]?.error).toContain("no longer current");
        }
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("does not dispatch auth or fetch for an exhausted budget", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    vi.spyOn(Date, "now").mockReturnValue(usageNow);
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue({ token: "fixture-token" });
    const result = await load({
      providers: ["anthropic"],
      env: { ANTHROPIC_API_KEY: "fixture-token" },
      timeoutMs: 0,
    });
    expect(result).toEqual({
      updatedAt: usageNow,
      providers: [{ ...claude, error: "Timeout" }],
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
      vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ context }) => {
        await (signalSource === "init"
          ? context.fetchFn("https://usage.example.test", { signal: caller.signal })
          : context.fetchFn(new Request("https://usage.example.test", { signal: caller.signal })));
        return claude;
      });
      const pending = scope.track(() =>
        load({
          auth: [{ provider: "anthropic", token: "fixture-token" }],
          timeoutMs: 1,
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
          { ...claude, error: callerAbort ? "Caller cancelled" : "Timeout" },
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
        load({
          providers: ["anthropic"],
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

  it("returns completed non-ignored siblings at the deadline while retaining unfinished work", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(unusedFetch());
    const scope = new AsyncWorkScope();
    const heldSnapshot = createDeferredCore<ProviderUsageSnapshot>();
    const balance: ProviderUsageSnapshot = {
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥42.50",
    };
    const lateSnapshot: ProviderUsageSnapshot = {
      ...claude,
      windows: [{ label: "5h", usedPercent: 20 }],
    };
    let summaryPromise: Promise<UsageSummary> | undefined;
    let draining: Promise<void> | undefined;
    ignoredErrors.add("HTTP 500");
    try {
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => {
        if (provider === "anthropic") {
          return await heldSnapshot.promise;
        }
        if (provider === "ignored") {
          return { ...claude, provider, error: "HTTP 500" };
        }
        return structuredClone(provider === "deepseek" ? balance : { ...codex, provider });
      });
      summaryPromise = scope.track(() =>
        load({
          auth: [
            { provider: "anthropic", token: "token-a" },
            { provider: "openai", token: "token-codex" },
            { provider: "deepseek", token: "token-d" },
            { provider: "ignored", token: "token-ignored" },
          ],
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
      expect(summary.providers).toEqual([{ ...claude, error: "Timeout" }, codex, balance]);
      expect(fetch).not.toHaveBeenCalled();
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
      ignoredErrors.delete("HTTP 500");
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

    const summary = await load({
      providers: ["anthropic", "openai"],
      // Credential sources keep both providers past the plugin-auth gate so the
      // sibling-isolation behavior under test is actually exercised.
      env: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" },
    });

    expect(summary.providers).toEqual([
      { ...claude, error: "auth failed" },
      {
        provider: "openai",
        displayName: "openai",
        windows: [{ label: "5h", usedPercent: 12 }],
      },
    ]);
  });

  it.each([
    ["xiaomi", "Xiaomi"],
    ["unsupported-provider", "unsupported-provider"],
  ])("returns unsupported %s without ambient fetch", async (provider, displayName) => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      const summary = await load({
        auth: [{ provider, token: "token-x" }],
      });
      expect(summary.providers).toEqual([
        { provider, displayName, windows: [], error: "Unsupported provider" },
      ]);
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
