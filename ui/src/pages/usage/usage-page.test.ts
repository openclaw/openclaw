/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  createPage,
  createPendingUsageRouteData,
  focusDocument,
  preloadUsage,
  refreshButton,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

describe("UsagePage cache convergence", () => {
  it("retains committed totals without polling and rereads each usage publication once", async () => {
    vi.useFakeTimers();
    focusDocument();
    let snapshot = cacheSnapshot("stale");
    const request = vi.fn(async (method: string) =>
      method === "usage.status" ? { updatedAt: 1, providers: [] } : snapshot.result,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, true, context);
    await preloadUsage(page);
    await vi.advanceTimersByTimeAsync(35_000);
    await page.updateComplete;

    expect(page.querySelector(".usage-overview-card")).not.toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
    context.publishUsage({ usageUpdatedAt: Date.now(), usageRefreshFailed: true });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")?.textContent).toContain(
      "Automatic checks paused",
    );
    expect(page.querySelector(".usage-overview-card")).not.toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
    snapshot = cacheSnapshot("fresh");
    const publication = { usageUpdatedAt: Date.now() + 1, usageRefreshFailed: false };
    context.publishUsage(publication);
    context.publishUsage(publication);
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(page.querySelector(".usage-cache-warning")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
    context.publishUsage(publication);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
  });

  it.each([
    { sessionCount: 0, emptyUsage: false, committed: false },
    { sessionCount: 1, emptyUsage: false, committed: false },
    { sessionCount: 1, emptyUsage: true, committed: false },
    { sessionCount: 1, emptyUsage: true, committed: true },
  ])(
    "distinguishes committed zero totals from an uncomputed cache ($sessionCount sessions, empty: $emptyUsage, committed: $committed)",
    async ({ sessionCount, emptyUsage, committed }) => {
      vi.useFakeTimers();
      focusDocument();
      const snapshot = cacheSnapshot("refreshing");
      const zeroTotals = {
        ...snapshot.result.totals,
        input: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
      };
      const result = {
        ...snapshot.result,
        totals: zeroTotals,
        sessions: Array.from({ length: sessionCount }, () => ({
          key: "agent:main:pending",
          usage: emptyUsage ? { ...zeroTotals, ...(committed ? { computedAt: 1 } : {}) } : null,
        })),
      };
      const request = vi.fn(async (method: string) =>
        method === "usage.status" ? { updatedAt: 1, providers: [] } : result,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, true, context);
      await preloadUsage(page);

      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(Boolean(page.querySelector(".usage-overview-card"))).toBe(committed);
      expect(Boolean(page.querySelector(".usage-header-metrics .usage-metric-badge"))).toBe(
        committed,
      );
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(page.textContent).not.toContain("Select a date range and click Refresh");

      await vi.advanceTimersByTimeAsync(35_000);
      await page.updateComplete;
      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(Boolean(page.querySelector(".usage-overview-card"))).toBe(committed);
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
      context.publishUsage({ usageUpdatedAt: 1, usageRefreshFailed: true });
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(page.querySelector(".usage-loading-card")).toBeNull();
      expect(page.querySelector(".usage-cache-warning.warning")?.textContent).toContain(
        "Automatic checks paused",
      );
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      await page.loadUsage();
      await page.updateComplete;
      expect(page.querySelector(".usage-loading-card")).toBeNull();
      expect(page.querySelector(".usage-cache-warning.warning")?.textContent).toContain(
        "Automatic checks paused",
      );
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
      refreshButton(page).click();
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(4);
    },
  );

  it.each(["main", "constructor", null])(
    "keeps interleaved refresh outcomes with their owning agent for scope %s",
    async (scopeId) => {
      vi.useFakeTimers();
      focusDocument();
      const ownerAgentId = scopeId ?? "main";
      const request = vi.fn(async (method: string, _params?: unknown) =>
        method === "usage.status" ? { updatedAt: 1, providers: [] } : cacheSnapshot("stale").result,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      context.agentSelection.state.scopeId = scopeId;
      const page = await createPage(client, true, context);
      await preloadUsage(page);
      expect(request.mock.calls.find(([method]) => method === "sessions.usage")?.[1]).toMatchObject(
        scopeId ? { agentId: scopeId } : { agentScope: "all" },
      );
      for (const [index, agentId, failed, paused, reads] of [
        [1, "other", true, scopeId === null, 1],
        [2, ownerAgentId, false, scopeId === null, 2],
        [3, ownerAgentId, true, true, 2],
        [4, "other", false, true, scopeId === null ? 3 : 2],
        [5, ownerAgentId, false, false, scopeId === null ? 4 : 3],
      ] as const) {
        context.publishUsage({ agentId, usageUpdatedAt: index, usageRefreshFailed: failed });
        await vi.advanceTimersByTimeAsync(0);
        await page.updateComplete;
        expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(paused);
        expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(
          reads,
        );
      }
    },
  );

  it.each(["scope", "time zone", "date", "creator"] as const)(
    "preserves failure until publication after changing the query's %s",
    async (control) => {
      vi.useFakeTimers();
      focusDocument();
      let snapshot = cacheSnapshot("partial");
      const request = vi.fn(async (method: string) =>
        method === "usage.status"
          ? { updatedAt: 1, providers: [] }
          : { ...snapshot.result, creatorOptions: [{ key: "user:one" }] },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, true, context);
      await preloadUsage(page);
      context.publishUsage({ usageUpdatedAt: 1, usageRefreshFailed: true });
      await page.updateComplete;
      expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
      if (control === "scope") {
        const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (entry) => entry.textContent?.trim() === "Current instance",
        );
        button!.click();
      } else if (control === "time zone") {
        const select = page.querySelector<HTMLSelectElement>("select.usage-select")!;
        select.value = "utc";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (control === "creator") {
        const select = page.querySelector<HTMLSelectElement>("select.usage-creator-filter")!;
        select.value = "user:one";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const input = page.querySelector<HTMLInputElement>("input.usage-date-input")!;
        input.value = "2026-08-01";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
      await page.updateComplete;
      expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
      snapshot = cacheSnapshot("fresh");
      context.publishUsage({ usageUpdatedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.providerUsageStalled).toBe(false);
    },
  );

  it("acknowledges only failed receipts in the explicit Refresh scope", async () => {
    vi.useFakeTimers();
    focusDocument();
    const request = vi.fn(async (method: string, _params?: unknown) =>
      method === "usage.status" ? { updatedAt: 1, providers: [] } : cacheSnapshot("stale").result,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    context.agentSelection.setScope("main");
    const page = await createPage(client, true, context);
    await preloadUsage(page);
    context.publishUsage({ agentId: "other", usageUpdatedAt: 1, usageRefreshFailed: true });
    context.publishUsage({ agentId: "main", usageUpdatedAt: 2, usageRefreshFailed: true });
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
    refreshButton(page).click();
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
    for (const [scopeId, paused] of [
      ["other", true],
      ["main", false],
      [null, true],
    ] as const) {
      context.agentSelection.setScope(scopeId);
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(
        request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1],
      ).toMatchObject(scopeId ? { agentId: scopeId } : { agentScope: "all" });
      expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(paused);
    }
    refreshButton(page).click();
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
    context.publishUsage({ agentId: "main", usageUpdatedAt: 3, usageRefreshFailed: true });
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "coalesces publications received while an older usage request is pending (%s)",
    async (completion) => {
      vi.useFakeTimers();
      focusDocument();
      const stale = cacheSnapshot("stale").result;
      const fresh = cacheSnapshot("fresh").result;
      const pending = deferred<SessionsUsageResult>();
      let phase: "stale" | "pending" | "fresh" = "stale";
      const request = vi.fn(async (method: string) => {
        if (method === "usage.status") {
          return { updatedAt: 1, providers: [] };
        }
        return phase === "pending" ? pending.promise : phase === "stale" ? stale : fresh;
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, true, context);
      await preloadUsage(page);
      phase = "pending";
      refreshButton(page).click();
      for (const usageUpdatedAt of [1, 1, 2]) {
        context.publishUsage({ usageUpdatedAt });
      }
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
      phase = "fresh";
      if (completion === "resolve") {
        pending.resolve(stale);
      } else {
        pending.reject(new Error("older usage read failed"));
      }
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.usageError).toBeNull();
      context.publishUsage({ usageUpdatedAt: 2 });
      await vi.advanceTimersByTimeAsync(35_000);
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
    },
  );

  it("defers a publication while hidden and catches up once when visible", async () => {
    vi.useFakeTimers();
    focusDocument();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    let snapshot = cacheSnapshot("fresh");
    const request = vi.fn(async (method: string) =>
      method === "usage.status" ? { updatedAt: 1, providers: [] } : snapshot.result,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, true, context);
    await preloadUsage(page);
    visibility.mockReturnValue("hidden");
    snapshot = cacheSnapshot("fresh");
    context.publishUsage({ usageUpdatedAt: 1 });
    context.publishUsage({ usageUpdatedAt: 2 });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
    visibility.mockReturnValue("visible");
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
    page.remove();
    context.publishUsage({ usageUpdatedAt: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
  });

  it.each([
    { publication: "before", failed: false, failureAfterCommit: "none" },
    { publication: "during", failed: false, failureAfterCommit: "none" },
    { publication: "before", failed: true, failureAfterCommit: "none" },
    { publication: "during", failed: true, failureAfterCommit: "none" },
    { publication: "existing", failed: true, failureAfterCommit: "none" },
    { publication: "during", failed: false, failureAfterCommit: "other" },
    { publication: "during", failed: false, failureAfterCommit: "main" },
  ])(
    "adopts a preload publication $publication the request (failed: $failed, later failure: $failureAfterCommit) without losing or duplicating its refresh",
    async ({ publication, failed, failureAfterCommit }) => {
      vi.useFakeTimers();
      focusDocument();
      let snapshot = cacheSnapshot("stale");
      const provider = deferred<{ updatedAt: number; providers: never[] }>();
      const usageStarted = deferred();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.usage") {
          usageStarted.resolve();
        }
        return method === "usage.status" ? provider.promise : snapshot.result;
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      context.setGatewaySnapshot({ hello: gatewayHelloForMethods(["sessions.usage"]) });
      const publish = () => {
        if (!failed && failureAfterCommit === "none") {
          snapshot = cacheSnapshot("fresh");
        }
        context.publishUsage({ usageUpdatedAt: 1, usageRefreshFailed: failed });
        if (failureAfterCommit !== "none") {
          context.publishUsage({
            agentId: failureAfterCommit,
            usageUpdatedAt: 2,
            usageRefreshFailed: true,
          });
        }
      };
      if (publication === "existing") {
        publish();
      }
      const page = await createPage(client, true, context);
      const preload = preloadUsage(page);
      if (publication === "before") {
        publish();
      }
      await usageStarted.promise;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
      if (publication === "during") {
        publish();
      }
      provider.resolve({ updatedAt: 1, providers: [] });
      await preload;
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(
        publication === "during" && !failed ? 2 : 1,
      );
      expect(Boolean(page.querySelector(".usage-cache-warning"))).toBe(
        failed || failureAfterCommit !== "none",
      );
      expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(
        failed || failureAfterCommit !== "none",
      );
    },
  );

  it("does not transfer a manual detail refresh to a replacement selection", async () => {
    const snapshot = cacheSnapshot("fresh");
    const keys = ["agent:main:a", "agent:main:b"];
    const result = {
      ...snapshot.result,
      sessions: keys.map((key) => ({ key, usage: snapshot.result.totals })),
    };
    const manual = deferred<typeof result>();
    let refreshing = false;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return refreshing ? manual.promise : result;
      }
      if (method === "sessions.usage.timeseries") {
        return { points: [] };
      }
      if (method === "sessions.usage.logs") {
        return { logs: [{ timestamp: Date.now(), role: "user", content: String(params?.key) }] };
      }
      return { providers: [] };
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[0]!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[0]),
    );

    refreshing = true;
    refreshButton(page).click();
    page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[1]!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[1]),
    );
    manual.resolve(result);
    await vi.waitFor(() => expect(refreshButton(page).disabled).toBe(false));

    expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[1]);
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      expect(
        request.mock.calls.filter(([called]) => called === method).map(([, params]) => params?.key),
      ).toEqual(keys);
    }
  });
});

describe("UsagePage provider usage outcome", () => {
  it.each(["idle", "pending", "hidden"] as const)(
    "preserves the provider retry budget through %s usage publications",
    async (state) => {
      vi.useFakeTimers();
      focusDocument();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      let providerUsageRefreshing = true;
      let heldUsage: ReturnType<typeof deferred<SessionsUsageResult>> | undefined;
      const client = {
        request: vi.fn(async (method: string) =>
          method === "usage.status"
            ? { updatedAt: 1, providers: [], refreshing: providerUsageRefreshing }
            : (heldUsage?.promise ?? cacheSnapshot("fresh").result),
        ),
      } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, false, context);
      await preloadUsage(page);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let pending: Promise<void> | undefined;
        if (state === "pending") {
          heldUsage = deferred<SessionsUsageResult>();
          pending = page.loadUsage();
        } else if (state === "hidden") {
          visibility.mockReturnValue("hidden");
        }
        context.publishUsage({ usageUpdatedAt: attempt + 1 });
        if (state === "pending") {
          heldUsage!.resolve(cacheSnapshot("fresh").result);
          heldUsage = undefined;
          await pending;
        } else if (state === "hidden") {
          visibility.mockReturnValue("visible");
          window.dispatchEvent(new Event("focus"));
        }
        await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
      }
      expect(page.providerUsageStalled).toBe(true);
      providerUsageRefreshing = false;
      await page.loadUsage();
      expect(page.providerUsageStalled).toBe(false);
    },
  );

  it.each(["direct", "preload"] as const)(
    "retries a failed %s provider usage result on the next page activation",
    async (loadSource) => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let providerUnavailable = loadSource === "direct";
      const request = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "usage.status") {
          if (providerUnavailable) {
            throw new Error("provider usage unreachable");
          }
          return { updatedAt: 2, providers: [] };
        }
        return cacheSnapshot("fresh").result;
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient);
      page.routeData = {
        ...createPendingUsageRouteData(page.context.gateway, "2026-08-07"),
        providerUsage:
          loadSource === "preload"
            ? {
                state: "settled",
                result: { ok: false, error: { kind: "request-failed" } },
              }
            : { state: "pending" },
        loadedAtMs: loadSource === "preload" ? Date.now() : null,
      };
      await page.updateComplete;
      if (loadSource === "direct") {
        (
          page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
        ).refreshPolicy.request("manual");
        await vi.waitFor(() => expect(page.providerUsageUnavailable).toBe(true));
      }
      const previousCalls = request.mock.calls.filter(
        ([method]) => method === "usage.status",
      ).length;
      providerUnavailable = false;

      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => {
        expect(request.mock.calls.filter(([method]) => method === "usage.status")).toHaveLength(
          previousCalls + 1,
        );
      });
      await vi.waitFor(() =>
        expect(page.providerUsageSummary).toEqual({ updatedAt: 2, providers: [] }),
      );
    },
  );

  it("keeps the last successful provider usage data when a later aggregate load fails", async () => {
    let phase = 1;
    const summary = { updatedAt: 1, providers: [{ provider: "openai", windows: [] }] };
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "usage.status") {
        return summary;
      }
      if (phase === 2) {
        throw new Error("usage unavailable");
      }
      return cacheSnapshot("fresh").result;
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    page.routeData = createPendingUsageRouteData(page.context.gateway, "2026-08-07");
    await page.updateComplete;

    const refresh = () => {
      (
        page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
      ).refreshPolicy.request("manual");
    };
    refresh();
    await vi.waitFor(() => {
      expect(page.providerUsageSummary).toEqual(summary);
    });

    phase = 2;
    refresh();
    await vi.waitFor(() => {
      expect(page.usageError).not.toBeNull();
    });
    expect(page.providerUsageSummary).toEqual(summary);
  });

  it("clears a stale provider request failure when a later aggregate load fails", async () => {
    let phase = 1;
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "usage.status") {
        if (phase === 1) {
          throw new Error("provider usage unreachable");
        }
        return { updatedAt: 2, providers: [] };
      }
      if (phase === 2) {
        throw new Error("usage unavailable");
      }
      return cacheSnapshot("fresh").result;
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    page.routeData = createPendingUsageRouteData(page.context.gateway, "2026-08-07");
    await page.updateComplete;

    // First load: only usage.status fails; the notice flag records the failure.
    const refresh = () => {
      (
        page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
      ).refreshPolicy.request("manual");
    };
    refresh();
    await vi.waitFor(() => {
      expect(page.providerUsageUnavailable).toBe(true);
    });

    // Second load: usage.status succeeds but sessions.usage fails.
    // The stale flag must not keep claiming the last provider request failed.
    phase = 2;
    refresh();
    await vi.waitFor(() => {
      expect(page.usageError).not.toBeNull();
    });
    expect(page.providerUsageUnavailable).toBe(false);
  });
});
