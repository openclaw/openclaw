import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { buildAuthHealthSummary } from "../../agents/auth-health.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { createOpenAiCodexOauthHealthSummary } from "./models-auth-status.health.test-support.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type RespondOptions = GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };

/** Shares the auth-status suite's prepared credential fixtures and cleanup. */
export function registerModelAuthStatusUsageRefreshTests({
  mocks,
  readAuthStatus,
  warmOAuthUsage,
  createOptions,
}: {
  mocks: {
    buildAuthHealthSummary: Mock<typeof buildAuthHealthSummary>;
    loadProviderUsageSummary: Mock<() => Promise<UsageSummary>>;
    refreshRuntimeAuthProfileStoreSources: Mock;
    refreshActiveProviderAuthRuntimeSnapshot: Mock;
    loadDeferredCatalog: Mock;
  };
  readAuthStatus: (params?: Record<string, unknown>) => Promise<ModelAuthStatusResult>;
  warmOAuthUsage: () => Promise<void>;
  createOptions: (params?: Record<string, unknown>) => RespondOptions;
}) {
  const handler = expectDefined(
    modelsAuthStatusHandlers["models.authStatus"],
    "auth-status handler",
  );
  const firstRespondCall = (options: RespondOptions) => options.respond.mock.calls[0];
  const expectSuccess = (options: RespondOptions, payload: unknown) =>
    expect(firstRespondCall(options)).toEqual([true, payload, undefined]);
  it("keeps same-account stale usage visible during an explicit refresh", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    await warmOAuthUsage();

    const { promise: refreshBlocked, resolve: releaseRefresh } = createDeferred();
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await refreshBlocked;
      return {
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 20 }],
          },
        ],
      };
    });

    const refreshing = await readAuthStatus({ refresh: true });
    expect(refreshing.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    const concurrent = await readAuthStatus({ refresh: true });
    expect(concurrent.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    releaseRefresh();
    await vi.waitFor(
      async () => {
        expect((await readAuthStatus()).providers[0]?.usage?.windows[0]?.usedPercent).toBe(20);
      },
      { interval: 1 },
    );
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("awaits shared usage-only refreshes without rediscovering credentials", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    await warmOAuthUsage();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const fresh = createDeferred<UsageSummary>();
    mocks.loadProviderUsageSummary.mockImplementation(() => fresh.promise);
    const one = createOptions({ refreshUsage: true });
    const two = createOptions({ refreshUsage: true });
    const pending = Promise.all([handler(one), handler(two)]);
    // An ordinary read remains non-blocking and sees the previous snapshot.
    expect((await readAuthStatus()).providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    fresh.resolve({
      updatedAt: 1,
      providers: [
        { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 20 }] },
      ],
    });
    await pending;
    for (const options of [one, two]) {
      expectSuccess(
        options,
        expect.objectContaining({
          providers: expect.arrayContaining([
            expect.objectContaining({
              usage: expect.objectContaining({
                windows: [{ label: "5h", usedPercent: 20 }],
              }),
            }),
          ]),
        }),
      );
    }
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    expect(mocks.refreshRuntimeAuthProfileStoreSources).not.toHaveBeenCalled();
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    expect((await readAuthStatus()).providers[0]?.usage?.windows[0]?.usedPercent).toBe(20);
  });

  it("retains last good usage when a usage-only fetch times out", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    await warmOAuthUsage();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 1,
      providers: [{ provider: "openai", displayName: "OpenAI", windows: [], error: "Timeout" }],
    });
    expect((await readAuthStatus({ refreshUsage: true })).providers[0]?.usage?.windows).toEqual([
      { label: "5h", usedPercent: 10 },
    ]);
  });

  it.each(["HTTP 503", "Unauthorized"])(
    "reports a usage-only provider failure instead of returning empty quota: %s",
    async (error) => {
      mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
      await warmOAuthUsage();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      mocks.loadProviderUsageSummary.mockResolvedValue({
        updatedAt: 1,
        providers: [{ provider: "openai", displayName: "OpenAI", windows: [], error }],
      });
      const options = createOptions({ refreshUsage: true });
      await handler(options);
      expect(firstRespondCall(options)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("Provider usage refresh failed for openai"),
        }),
      ]);
      expect((await readAuthStatus()).providers[0]?.usage?.windows).toEqual([
        { label: "5h", usedPercent: 10 },
      ]);
    },
  );
}
