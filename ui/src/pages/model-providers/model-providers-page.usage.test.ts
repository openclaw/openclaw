/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import {
  expectAbsent,
  expectContent,
  expectPresent,
  profile,
} from "../../test-helpers/model-providers.ts";
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
  it("refreshes only expired provider usage on activation and retains the displayed plan", async () => {
    vi.useFakeTimers();
    focusDocument();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const harness = createHarness("main");
    const replacement = deferred<unknown>();
    const request = harness.request.getMockImplementation()!;
    harness.request.mockImplementation((method, ...args) =>
      method === "usage.status" ? replacement.promise : request(method, ...args),
    );
    const plans = (plan: string) => ({
      updatedAt: Date.now(),
      providers: [{ provider: "openai", displayName: "OpenAI", plan, windows: [] }],
    });
    const page = createPage(harness.context);
    mountPage(page);
    const loadedAt = Date.now();
    publishRouteData(page, {
      ...createApiKeyProviderData(),
      updatedAt: loadedAt,
      providerUsage: plans("Original"),
    });
    const plan = () => page.querySelector(".provider-row__plan")?.textContent;
    await waitForSolid(() => expect(plan()).toBe("Original"));
    await waitForProviders(page);
    expect(requestCount(harness.request, "usage.status")).toBe(0);
    harness.request.mockClear();

    const activate = () => window.dispatchEvent(new Event("focus"));
    vi.setSystemTime(loadedAt + 300_000 - 1);
    activate();
    expect(harness.request).not.toHaveBeenCalled();

    vi.setSystemTime(loadedAt + 300_000);
    visibility.mockReturnValue("hidden");
    activate();
    expect(harness.request).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    activate();
    activate();
    expect(harness.request.mock.calls.map(([method]) => method)).toEqual(["usage.status"]);
    expect(plan()).toBe("Original");

    replacement.resolve(plans("Updated"));
    await waitForSolid(() => expect(plan()).toBe("Updated"));
    activate();
    expect(harness.request.mock.calls.map(([method]) => method)).toEqual(["usage.status"]);
  });

  it("keeps account quotas during config saves and refreshes them from the page", async () => {
    const { context, request, snapshot, runtimeConfig, notifyRuntimeConfig } =
      createHarness("main");
    snapshot.hello!.features!.methods!.push("codex.accountUsage");
    const original = request.getMockImplementation()!;
    let usedPercent = 10;
    const initial = deferred();
    const slow = deferred();
    const accountRequests: unknown[] = [];
    request.mockImplementation(async (method, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profileOrder: ["openai:one", "openai:key", "openai:two"],
            profiles: [
              profile("openai:one"),
              profile("openai:two", { type: "token", status: "static" }),
              profile("openai:key", { type: "api_key", status: "static" }),
            ],
          },
          { provider: "anthropic", displayName: "Anthropic", profiles: [profile("anthropic:one")] },
        ]);
      }
      if (method === "codex.accountUsage") {
        accountRequests.push(params);
        if (accountRequests.length === 1) {
          throw new Error("Offline");
        }
        if (accountRequests.length === 2) {
          return initial.promise;
        }
        if (accountRequests.length === 4) {
          await slow.promise;
        }
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
    const segments = () => [...openai.querySelectorAll("[data-account-segment]")];
    const bars = openai.querySelector(".model-providers__usage-bars")!;
    const refresh = () =>
      page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await vi.waitFor(() => expectContent(bars, ["Signed-in account: Offline", "Loading…"]));
    expect([...bars.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual([
      "Loading…",
      "Signed-in account: Offline · Refresh to try again.",
    ]);
    // Opening the pending account adds credential actions, not a second copy of the grid outcome.
    bars.querySelectorAll<HTMLButtonElement>(".model-providers__segment-name")[1]!.click();
    const expanded = () =>
      openai.querySelector('[data-profile-id="openai:two"] .model-providers__account-limits');
    await waitForSolid(() => {
      expect(expanded()).not.toBeNull();
      expect(expanded()!.textContent).not.toContain("Loading");
    });
    initial.reject(new Error("Timed out"));
    const retryHint = "Access token: Timed out · Refresh to try again.";
    await vi.waitFor(() => expectContent(bars, [retryHint]));
    expect(expanded()!.textContent).not.toContain("Timed out");
    expect(segments()).toHaveLength(0);
    refresh();
    const expectLimits = (percent: number) => {
      const left = expect.stringContaining(`${percent}% left`);
      expect(segments().map((el) => el.ariaLabel)).toEqual([left, left]);
    };
    await vi.waitFor(() => expect(segments().map((el) => el.textContent)).toEqual(["90%", "—"]));
    slow.resolve();
    await vi.waitFor(() => expectLimits(90));
    expect(bars.textContent).not.toContain("Refresh to try again");
    expect(expanded()).not.toBeNull();
    expect(expanded()!.textContent).not.toMatch(/Timed out|Loading|90%/u);
    expect(accountRequests.slice(2)).toEqual([
      { agentId: "main", profileId: "openai:one" },
      { agentId: "main", profileId: "openai:two" },
    ]);
    const ids = segments().map((el) => el.getAttribute("data-account-segment"));
    expect(ids).toEqual(["openai:one", "openai:two"]);
    expectAbsent(anthropic, ".model-providers__account-limits");
    expectAbsent(openai, '[data-profile-id="openai:key"] .model-providers__account-limits');
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    await page.updateComplete;
    expectLimits(90);
    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    usedPercent = 90;
    refresh();
    await vi.waitFor(() => expectLimits(10));
    expect(accountRequests).toHaveLength(6);
    segments()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        agentId: "main",
        profileIds: ["openai:two", "openai:key", "openai:one"],
      }),
    );
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
      expectContent(page.renderRoot, ["Couldn’t finish loading provider usage"]);

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
    page.routeData = { ...page.routeData!, provider: "openai" };
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
      expectContent(page.renderRoot, ["Couldn’t load provider usage. Refresh to try again."]),
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
