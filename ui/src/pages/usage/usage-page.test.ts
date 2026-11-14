/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createUsagePageFixture,
  loadUsagePage,
  settleUsageTimers,
  usageCalls,
  textOf,
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  createPage,
  createPendingUsageRouteData,
  focusDocument,
  preloadUsage,
  refreshButton,
  selectUsageSession,
  changeUsageControl,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

function usageRequest(
  usage: (params?: Record<string, unknown>) => unknown,
  provider = (): unknown => ({ updatedAt: 1, providers: [] }),
) {
  return vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === "usage.status" ? provider() : usage(params),
  );
}

it("retires usage before a restricted reconnect can refresh the mounted page", async () => {
  vi.useFakeTimers();
  focusDocument();
  const snapshot = cacheSnapshot("fresh");
  const request = usageRequest(() => snapshot.result);
  const { context, page } = await loadUsagePage(request, false, (application) =>
    application.setGatewaySnapshot({
      hello: gatewayHelloForMethods(["sessions.usage", "usage.status"]),
    }),
  );
  await settleUsageTimers(page, 300_001);
  context.setGatewaySnapshot({ phase: "reconnecting" });
  request.mockClear();
  context.setGatewaySnapshot({
    phase: "connected",
    hello: gatewayHelloForMethods(["sessions.usage", "usage.status"], ["operator.sessions.read"]),
  });
  expect(request).not.toHaveBeenCalled();
  await settleUsageTimers(page);
  await page.refresh();
  expect(request).not.toHaveBeenCalled();
  expect(page.usageResult).toBeNull();
});

describe("UsagePage cache convergence", () => {
  it("shows an exhausted empty page as partial and clears its message after refresh", async () => {
    const message =
      "Usage request exceeded its 15-second budget; narrow the date range or select a session.";
    let result: SessionsUsageResult = {
      ...cacheSnapshot("partial").result,
      partial: { reason: "time-budget", message },
    };
    const request = usageRequest(() => result);
    const { page } = await loadUsagePage(request);
    expect(page.querySelector(".callout.danger")).toBeNull();
    expect(
      page.querySelector(".usage-partial-notice:not(.usage-partial-notice--off)")?.textContent,
    ).toContain(message);
    expect(page.textContent).not.toContain("Select a date range and click Refresh");

    result = cacheSnapshot("fresh").result;
    refreshButton(page).click();
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.querySelector(".usage-partial-notice")?.classList).toContain(
      "usage-partial-notice--off",
    );
  });

  beforeEach(() => {
    vi.useFakeTimers();
    focusDocument();
  });
  it.each([false, true])(
    "retains committed totals and coalesces publications (hidden: %s)",
    async (hidden) => {
      const visibility = vi.spyOn(document, "visibilityState", "get");
      let snapshot = cacheSnapshot(hidden ? "fresh" : "stale");
      const request = usageRequest(() => snapshot.result);
      const { context, page } = await loadUsagePage(request);
      await settleUsageTimers(page, 35_000);

      expect(page.querySelector(".usage-overview-card")).not.toBeNull();
      expect(usageCalls(request)).toHaveLength(1);
      if (!hidden) {
        context.publishUsage({ usageUpdatedAt: Date.now(), usageRefreshFailed: true });
        await settleUsageTimers(page);
        expect(textOf(page, ".usage-cache-warning.warning")).toContain("Automatic checks paused");
        expect(page.querySelector(".usage-overview-card")).not.toBeNull();
        expect(usageCalls(request)).toHaveLength(1);
      }
      snapshot = cacheSnapshot("fresh");
      if (hidden) {
        visibility.mockReturnValue("hidden");
      }
      const publication = { usageUpdatedAt: Date.now() + 1, usageRefreshFailed: false };
      context.publishUsage(publication);
      context.publishUsage(publication);
      if (hidden) {
        publication.usageUpdatedAt += 1;
        context.publishUsage(publication);
        await vi.advanceTimersByTimeAsync(35_000);
        expect(usageCalls(request)).toHaveLength(1);
        visibility.mockReturnValue("visible");
        window.dispatchEvent(new Event("focus"));
      }
      await settleUsageTimers(page);

      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(usageCalls(request)).toHaveLength(2);
      context.publishUsage(publication);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(usageCalls(request)).toHaveLength(2);
      page.remove();
      context.publishUsage({ usageUpdatedAt: publication.usageUpdatedAt + 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(usageCalls(request)).toHaveLength(2);
    },
  );

  it.each([
    { sessionCount: 0, emptyUsage: false, committed: false },
    { sessionCount: 1, emptyUsage: false, committed: false },
    { sessionCount: 1, emptyUsage: true, committed: false },
    { sessionCount: 1, emptyUsage: true, committed: true },
  ])(
    "distinguishes committed zero totals from an uncomputed cache ($sessionCount sessions, empty: $emptyUsage, committed: $committed)",
    async ({ sessionCount, emptyUsage, committed }) => {
      const snapshot = cacheSnapshot("refreshing");
      const zeroTotals = createEmptyCostUsageTotals();
      const result = {
        ...snapshot.result,
        totals: zeroTotals,
        sessions: Array.from({ length: sessionCount }, () => ({
          key: "agent:main:pending",
          usage: emptyUsage ? { ...zeroTotals, ...(committed ? { computedAt: 1 } : {}) } : null,
        })),
      };
      const request = usageRequest(() => result);
      const { context, page } = await loadUsagePage(request);

      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(Boolean(page.querySelector(".usage-overview-card"))).toBe(committed);
      // Badges keep their slots; uncomputed totals show placeholders, never values.
      expect(
        [...page.querySelectorAll(".usage-summary-strip .usage-metric-badge strong")].every(
          (node) => node.textContent === "—",
        ),
      ).toBe(!committed);
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(page.textContent).not.toContain("Select a date range and click Refresh");

      await settleUsageTimers(page, 35_000);
      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(Boolean(page.querySelector(".usage-overview-card"))).toBe(committed);
      expect(usageCalls(request)).toHaveLength(1);
      context.publishUsage({ usageUpdatedAt: 1, usageRefreshFailed: true });
      await settleUsageTimers(page);
      expect(page.querySelector(".usage-loading-card")).toBeNull();
      expect(textOf(page, ".usage-cache-warning.warning")).toContain("Automatic checks paused");
      expect(usageCalls(request)).toHaveLength(1);
      window.dispatchEvent(new Event("focus"));
      await settleUsageTimers(page);
      expect(page.querySelector(".usage-loading-card")).toBeNull();
      expect(textOf(page, ".usage-cache-warning.warning")).toContain("Automatic checks paused");
      expect(usageCalls(request)).toHaveLength(2);
      refreshButton(page).click();
      await settleUsageTimers(page);
      expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
      expect(Boolean(page.querySelector(".usage-loading-card"))).toBe(!committed);
      expect(usageCalls(request)).toHaveLength(3);
    },
  );

  it.each(["constructor", null])(
    "keeps interleaved refresh outcomes with their owning agent for scope %s",
    async (scopeId) => {
      const ownerAgentId = scopeId ?? "main";
      const request = usageRequest(() => cacheSnapshot("stale").result);
      const { context, page } = await loadUsagePage(request, true, (initial) => {
        initial.agentSelection.state.scopeId = scopeId;
      });
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
        await settleUsageTimers(page);
        expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(paused);
        expect(usageCalls(request)).toHaveLength(reads);
      }
    },
  );

  it("preserves failure until publication after changing the query's date", async () => {
    let snapshot = cacheSnapshot("partial");
    const request = usageRequest(() => ({
      ...snapshot.result,
      creatorOptions: [{ key: "user:one" }],
    }));
    const { context, page } = await loadUsagePage(request);
    context.publishUsage({ usageUpdatedAt: 1, usageRefreshFailed: true });
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
    const input = page.querySelector<HTMLInputElement>("input.usage-date-input")!;
    changeUsageControl(input, "2026-08-01");
    await vi.advanceTimersByTimeAsync(400);
    expect(usageCalls(request)).toHaveLength(2);
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
    snapshot = cacheSnapshot("fresh");
    context.publishUsage({ usageUpdatedAt: Date.now() });
    await settleUsageTimers(page);
    expect(usageCalls(request)).toHaveLength(3);
    expect(page.querySelector(".usage-cache-warning")).toBeNull();
    expect(page.read().data.providerUsageStalled).toBe(false);
  });

  it("acknowledges only failed receipts in the explicit Refresh scope", async () => {
    const request = usageRequest(() => cacheSnapshot("stale").result);
    const { context, page } = await loadUsagePage(request, true, (initial) =>
      initial.agentSelection.setScope("main"),
    );
    context.publishUsage({ agentId: "other", usageUpdatedAt: 1, usageRefreshFailed: true });
    context.publishUsage({ agentId: "main", usageUpdatedAt: 2, usageRefreshFailed: true });
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
    refreshButton(page).click();
    await settleUsageTimers(page);
    expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
    for (const [scopeId, paused] of [
      ["other", true],
      ["main", false],
      [null, true],
    ] as const) {
      context.agentSelection.setScope(scopeId);
      await settleUsageTimers(page);
      expect(
        request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1],
      ).toMatchObject(scopeId ? { agentId: scopeId } : { agentScope: "all" });
      expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(paused);
    }
    refreshButton(page).click();
    await settleUsageTimers(page);
    expect(page.querySelector(".usage-cache-warning.warning")).toBeNull();
    context.publishUsage({ agentId: "main", usageUpdatedAt: 3, usageRefreshFailed: true });
    await page.updateComplete;
    expect(page.querySelector(".usage-cache-warning.warning")).not.toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "coalesces publications received while an older usage request is pending (%s)",
    async (completion) => {
      const stale = cacheSnapshot("stale").result;
      const fresh = cacheSnapshot("fresh").result;
      const pending = deferred<SessionsUsageResult>();
      let phase: "stale" | "pending" | "fresh" = "stale";
      const request = usageRequest(() =>
        phase === "pending" ? pending.promise : phase === "stale" ? stale : fresh,
      );
      const { context, page } = await loadUsagePage(request);
      phase = "pending";
      refreshButton(page).click();
      for (const usageUpdatedAt of [1, 1, 2]) {
        context.publishUsage({ usageUpdatedAt });
      }
      expect(usageCalls(request)).toHaveLength(2);
      phase = "fresh";
      if (completion === "resolve") {
        pending.resolve(stale);
      } else {
        pending.reject(new Error("older usage read failed"));
      }
      await settleUsageTimers(page);
      expect(usageCalls(request)).toHaveLength(3);
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.read().data.error).toBeNull();
      context.publishUsage({ usageUpdatedAt: 2 });
      await vi.advanceTimersByTimeAsync(35_000);
      expect(usageCalls(request)).toHaveLength(3);
    },
  );

  it.each([
    { publication: "before", failed: false, failureAfterCommit: "none" },
    { publication: "during", failed: false, failureAfterCommit: "none" },
    { publication: "before", failed: true, failureAfterCommit: "none" },
    { publication: "during", failed: true, failureAfterCommit: "none" },
    { publication: "existing", failed: true, failureAfterCommit: "none" },
    { publication: "during", failed: false, failureAfterCommit: "main" },
  ])(
    "adopts a preload publication $publication the request (failed: $failed, later failure: $failureAfterCommit) without losing or duplicating its refresh",
    async ({ publication, failed, failureAfterCommit }) => {
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
      expect(usageCalls(request)).toHaveLength(1);
      if (publication === "during") {
        publish();
      }
      provider.resolve({ updatedAt: 1, providers: [] });
      await preload;
      await settleUsageTimers(page);
      expect(usageCalls(request)).toHaveLength(publication === "during" && !failed ? 2 : 1);
      expect(Boolean(page.querySelector(".usage-cache-warning"))).toBe(
        failed || failureAfterCommit !== "none",
      );
      expect(Boolean(page.querySelector(".usage-cache-warning.warning"))).toBe(
        failed || failureAfterCommit !== "none",
      );
    },
  );
});

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
  const { page } = await loadUsagePage(request);
  selectUsageSession(page);
  await vi.waitFor(() => expect(textOf(page, ".session-log-content")).toBe(keys[0]));

  refreshing = true;
  refreshButton(page).click();
  selectUsageSession(page, 1);
  await vi.waitFor(() => expect(textOf(page, ".session-log-content")).toBe(keys[1]));
  manual.resolve(result);
  await vi.waitFor(() => expect(refreshButton(page).disabled).toBe(false));

  expect(textOf(page, ".session-log-content")).toBe(keys[1]);
  for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
    expect(
      request.mock.calls.filter(([called]) => called === method).map(([, params]) => params?.key),
    ).toEqual(keys);
  }
});

describe("UsagePage provider usage outcome", () => {
  beforeEach(focusDocument);
  it.each(["idle", "pending", "hidden"] as const)(
    "preserves the provider retry budget through %s usage publications",
    async (state) => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      let providerUsageRefreshing = true;
      let heldUsage: ReturnType<typeof deferred<SessionsUsageResult>> | undefined;
      const request = usageRequest(
        () => heldUsage?.promise ?? cacheSnapshot("fresh").result,
        () => ({ updatedAt: 1, providers: [], refreshing: providerUsageRefreshing }),
      );
      const { context, page } = await loadUsagePage(request, false);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (state === "pending") {
          heldUsage = deferred<SessionsUsageResult>();
          context.publishUsage({ usageUpdatedAt: attempt * 2 + 1 });
        } else if (state === "hidden") {
          visibility.mockReturnValue("hidden");
        }
        context.publishUsage({ usageUpdatedAt: attempt * 2 + 2 });
        if (state === "pending") {
          heldUsage!.resolve(cacheSnapshot("fresh").result);
          heldUsage = undefined;
          await vi.advanceTimersByTimeAsync(0);
        } else if (state === "hidden") {
          visibility.mockReturnValue("visible");
          window.dispatchEvent(new Event("focus"));
        }
        await vi.advanceTimersByTimeAsync(5_000 * 2 ** attempt);
      }
      expect(page.read().data.providerUsageStalled).toBe(true);
      providerUsageRefreshing = false;
      await page.refresh();
      expect(page.read().data.providerUsageStalled).toBe(false);
    },
  );

  it("keeps a failed session read stale after provider plans load", async () => {
    const request = vi.fn(async (method: string): Promise<unknown> =>
      method === "usage.status" ? { updatedAt: 1, providers: [] } : cacheSnapshot("fresh").result,
    );
    const { page } = await createUsagePageFixture(request, false);
    page.routeData = {
      ...createPendingUsageRouteData(page.context.gateway, "2026-08-07"),
      // The route's session read failed, so it carries no loaded timestamp.
      loadedAtMs: null,
      error: "usage unavailable",
    };
    await page.updateComplete;
    await vi.waitFor(() => expect(usageCalls(request, "usage.status")).toHaveLength(1));
    await page.updateComplete;
    const sessionReads = usageCalls(request, "sessions.usage").length;
    // Provider plans finishing must not mark the failed session read fresh.
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(usageCalls(request, "sessions.usage").length).toBeGreaterThan(sessionReads),
    );
  });

  it.each([
    { loadSource: "direct", failed: true, aggregateFails: false },
    { loadSource: "preload", failed: true, aggregateFails: false },
    { loadSource: "direct", failed: false, aggregateFails: true },
    { loadSource: "direct", failed: true, aggregateFails: true },
  ])(
    "recovers $loadSource provider outcomes (previous failure: $failed, aggregate fails: $aggregateFails)",
    async ({ loadSource, failed, aggregateFails }) => {
      let phase = 1;
      const summary = failed
        ? { updatedAt: 2, providers: [] }
        : { updatedAt: 1, providers: [{ provider: "openai", windows: [] }] };
      const request = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "usage.status") {
          if (failed && phase === 1) {
            throw new Error("provider usage unreachable");
          }
          return summary;
        }
        if (phase === 2 && aggregateFails) {
          throw new Error("usage unavailable");
        }
        return cacheSnapshot("fresh").result;
      });
      const { page } = await createUsagePageFixture(request, false);
      page.routeData = {
        ...createPendingUsageRouteData(page.context.gateway, "2026-08-07"),
        // A preload leaves fresh session usage; the page still reads provider plans itself.
        loadedAtMs: loadSource === "preload" ? Date.now() : null,
      };
      await page.updateComplete;
      if (loadSource === "direct") {
        await page.refresh();
      }
      // Provider plans load on the page for both entry paths.
      await vi.waitFor(() => {
        if (failed) {
          expect(page.read().data.providerUsageUnavailable).toBe(true);
        } else {
          expect(page.read().data.providerUsage).toEqual(summary.providers);
        }
      });
      const previousCalls = usageCalls(request, "usage.status").length;
      phase = 2;
      if (aggregateFails) {
        await page.refresh();
        await vi.waitFor(() => expect(page.read().data.error).not.toBeNull());
        expect(page.read().data.providerUsageUnavailable).toBe(false);
        if (!failed) {
          expect(page.read().data.providerUsage).toEqual(summary.providers);
        }
      } else {
        window.dispatchEvent(new Event("focus"));
        await vi.waitFor(() => {
          expect(usageCalls(request, "usage.status")).toHaveLength(previousCalls + 1);
        });
        await vi.waitFor(() => expect(page.read().data.providerUsage).toEqual(summary.providers));
      }
    },
  );
});
