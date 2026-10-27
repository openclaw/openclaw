/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { expectAbsent, expectContent, expectPresent } from "../../test-helpers/model-providers.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  createPage,
  mountPage,
  createAuthStatus,
  createApiKeyProviderData,
  createHarness,
  drainPageUpdates,
  expandProvider,
  requestCount,
  waitForProviders,
  advanceUsageRetries,
  focusDocument,
  publishRouteData,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage usage convergence", () => {
  it("keeps account quotas during config saves and refreshes them from the page", async () => {
    const { context, request, snapshot, runtimeConfig, notifyRuntimeConfig } =
      createHarness("main");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      features: { methods: ["config.get", "config.patch", "codex.accountUsage"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const original = request.getMockImplementation()!;
    let usedPercent = 10;
    const accountRequests: unknown[] = [];
    request.mockImplementation(async (method, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok" },
              { profileId: "openai:two", type: "token", status: "static" },
              { profileId: "openai:key", type: "api_key", status: "static" },
            ],
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            profiles: [{ profileId: "anthropic:one", type: "oauth", status: "ok" }],
          },
        ]);
      }
      if (method === "codex.accountUsage") {
        accountRequests.push(params);
        return {
          updatedAt: 1,
          providers: [
            { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent }] },
          ],
        };
      }
      return original(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    const openai = await expandProvider(page, "openai");
    const anthropic = await expandProvider(page, "anthropic");
    const limitsText = () =>
      [...openai.querySelectorAll(".model-providers__account-limits")].map(
        (limits) => limits.textContent,
      );
    const expectLimits = (remaining: number) =>
      expect(limitsText()).toEqual(
        Array.from({ length: 2 }, () => expect.stringContaining(`${remaining}% left`)),
      );
    await vi.waitFor(() => expectLimits(90));
    expect(accountRequests).toEqual([
      { agentId: "main", profileId: "openai:one" },
      { agentId: "main", profileId: "openai:two" },
    ]);
    expect(
      [...openai.querySelectorAll('.model-providers__account-limits [role="meter"]')].map((meter) =>
        meter.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["90", "90"]);
    for (const [row, id] of [
      [anthropic, "anthropic:one"],
      [openai, "openai:key"],
    ] as const) {
      expectAbsent(row, `[data-profile-id="${id}"] .model-providers__account-limits`);
    }
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    await page.updateComplete;
    expectLimits(90);
    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    usedPercent = 90;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    await vi.waitFor(() => expectLimits(10));
    expect(accountRequests).toHaveLength(4);
  });

  it.each(["reconnect", "manual refresh"] as const)(
    "restarts an exhausted retry cycle on %s",
    async (trigger) => {
      vi.useFakeTimers();
      focusDocument();
      const harness = createHarness("main");
      harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
      const page = appendPage(harness.context);
      await page.updateComplete;
      await advanceUsageRetries();
      await page.updateComplete;
      expectContent(page.renderRoot, ["did not finish loading"]);

      const usageCallsBeforeRestart = requestCount(harness.request, "usage.status");
      expect(usageCallsBeforeRestart).toBe(4);

      if (trigger === "manual refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
        await page.updateComplete;
        await advanceUsageRetries();
        expect(requestCount(harness.request, "usage.status")).toBeGreaterThan(
          usageCallsBeforeRestart + 1,
        );
        return;
      }

      harness.publishPhase("offline");
      await page.updateComplete;
      harness.publishPhase("connected");
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(requestCount(harness.request, "usage.status")).toBe(5);
    },
  );

  it.each(["core reconnect", "usage refresh"] as const)(
    "retires pending %s data before publishing its replacement",
    async (mode) => {
      const h = createHarness("main");
      const replacement = {
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "replacement", usedPercent: 25 }],
      };
      const stale = deferred<unknown>();
      const original = h.request.getMockImplementation()!;
      let firstSignal: AbortSignal | undefined;
      let reads = 0;
      h.request.mockImplementation(
        async (method, _params?: unknown, options?: { signal?: AbortSignal }) => {
          if (method !== "usage.status") {
            return original(method);
          }
          if (++reads === 1 && mode === "usage refresh") {
            firstSignal = options?.signal;
            return stale.promise;
          }
          return { updatedAt: 2, providers: [replacement] };
        },
      );
      const releaseOldCore = mode === "core reconnect" ? h.deferNextAuthStatus() : () => {};
      const page = appendPage(h.context);
      await page.updateComplete;
      if (mode === "core reconnect") {
        h.publishPhase("offline");
        await page.updateComplete;
        h.publishPhase("connected");
        await vi.waitFor(() => expect(reads).toBe(1));
        releaseOldCore();
      } else {
        await vi.waitFor(() => expect(reads).toBe(1));
        const releaseRefresh = h.deferNextAuthStatus();
        page.view.props.onRefresh();
        expect(firstSignal?.aborted).toBe(true);
        stale.resolve({
          updatedAt: 1,
          providers: [{ ...replacement, windows: [{ label: "stale", usedPercent: 1 }] }],
        });
        await Promise.resolve();
        expect(page.view.props.cards.every((card) => !card.usage)).toBe(true);
        releaseRefresh();
      }
      const current = () => page.view.props.cards.find((card) => card.id === "openai")?.usage;
      await vi.waitFor(() => expect(current()).toEqual(replacement));
      await drainPageUpdates(page);
      expect(current()).toEqual(replacement);
      expect(reads).toBe(mode === "core reconnect" ? 1 : 2);
      expect(requestCount(h.request, "sessions.usage")).toBe(0);
    },
  );

  it("gates provider reads on settled route data and retains controls through usage recovery", async () => {
    const harness = createHarness("main");
    const usage = deferred<unknown>();
    const original = harness.request.getMockImplementation()!;
    let usageReads = 0;
    let usageFails = true;
    harness.request.mockImplementation(async (method, ...args) => {
      if (method === "usage.status") {
        if (++usageReads === 1) {
          return usage.promise;
        }
        if (usageFails) {
          throw new Error("Usage temporarily unavailable");
        }
        return { updatedAt: 2, providers: [] };
      }
      if (method === "models.authStatus") {
        return createAuthStatus([{ status: "missing", profiles: [] }]);
      }
      return original(method, ...args);
    });
    const page = createPage(harness.context);
    mountPage(page);
    await page.updateComplete;
    const expectNoProviderReads = () =>
      expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);
    expectNoProviderReads();
    harness.publishPhase("offline");
    harness.publishPhase("connected");
    await page.updateComplete;
    expectNoProviderReads();
    page.loaderPending = true;
    publishRouteData(page, createApiKeyProviderData());
    await waitForSolid(() => expectPresent(page, '[data-provider-id="openai"]'));
    expect(usageReads).toBe(0);
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
    const search = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
    const row = page.querySelector('[data-provider-id="openai"]')!;
    const expectRetainedControls = () => {
      expect(requestCount(harness.request, "sessions.usage")).toBe(0);
      expect(page.querySelector('[data-provider-id="openai"]')).toBe(row);
      expect(page.querySelector(".model-providers__search input")).toBe(search);
      expect(document.activeElement).toBe(search);
      expect(row.querySelector(".provider-row__plan")?.textContent).toBe("Pro");
    };
    search.focus();
    page.loaderPending = false;
    await waitForSolid(() => expect(usageReads).toBe(1));
    expect(requestCount(harness.request, "models.authStatus")).toBe(0);
    usage.resolve({
      updatedAt: 1,
      providers: [{ provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] }],
    });
    await waitForSolid(() =>
      expect(row.querySelector(".provider-row__plan")?.textContent).toBe("Pro"),
    );
    expectRetainedControls();
    page.view.props.onRefresh();
    await waitForSolid(() =>
      expectContent(page.renderRoot, [
        "Provider usage is unavailable; the last request failed. Refresh to retry.",
      ]),
    );
    expectRetainedControls();
    usageFails = false;
    page.view.props.onRefresh();
    await waitForSolid(() => {
      expect(page.view.props.providerUsageFailed).toBe(false);
      expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toBeUndefined();
    });
    expectAbsent(page, ".provider-row__plan");
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
  });
});
