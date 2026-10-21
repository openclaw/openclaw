/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { mockDocumentVisibility as visibilityFixture } from "../test-helpers/mock-cleanup.ts";
import "./app-sidebar.tsx";

// Capture JSDOM's frame owner before the sidebar fixture installs its scheduler.
const requestNativeFrame = window.requestAnimationFrame.bind(window);
const cancelNativeFrame = window.cancelAnimationFrame.bind(window);
const catalogClock: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ["setTimeout", "clearTimeout", "Date"],
};
const page = (threadId: string, name: string) => catalogPage([{ threadId, name }]);
const busy = (retryAfterMs: number) =>
  new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "server busy",
    retryable: true,
    retryAfterMs,
  });

async function advance(request: GatewayRequestMock, ms: number, calls: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(request).toHaveBeenCalledTimes(calls);
}

async function mountTab(
  request = createGatewayRequestMock().mockResolvedValue(page("stable", "Stable catalog")),
  prepare?: (sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"]) => void,
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: gatewayHelloForMethods(["sessions.catalog.list"], ["operator.read"]),
  });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  prepare?.(sidebar);
  sidebar.connected = true;
  await settleLitElement(sidebar);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);
  return { sidebar, gateway, request };
}

describe("AppSidebar catalog event refresh", () => {
  beforeEach(() => {
    // Catalog retries use timeouts; JSDOM retains its native frame interval.
    vi.useFakeTimers(catalogClock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores session churn, polls every two minutes, and coalesces tab activation", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockResolvedValue(page("discovered", "New catalog row"));
    const { gateway, sidebar } = await mountTab(request);
    for (const agentId of ["research", "main"]) {
      gateway.publishEvent("sessions.changed", { agentId, sessionKey: `agent:${agentId}:x` });
      await advance(request, 5_000, 1);
    }
    await advance(request, 109_999, 1);
    await advance(request, 1, 2);
    expect(sidebar.textContent).toContain("New catalog row");
    await advance(request, 119_999, 2);
    await advance(request, 1, 3);
    await advance(request, 6 * 60_000, 6);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(request, 5_000, 7);
  });

  it.each(["recovered", "exhausted"] as const)("paces busy retries until %s", async (outcome) => {
    const error = busy(outcome === "recovered" ? 5_000 : 100);
    const request = createGatewayRequestMock().mockResolvedValueOnce(
      page("stable", "Stable catalog"),
    );
    if (outcome === "recovered") {
      request.mockRejectedValueOnce(error).mockResolvedValue(page("updated", "Updated catalog"));
    } else {
      request.mockRejectedValue(error);
    }
    const { sidebar } = await mountTab(request);
    await sidebar.sessionData.refreshSessionCatalogs();
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Stable catalog");
    expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    if (outcome === "recovered") {
      for (let second = 0; second < 4; second += 1) {
        document.dispatchEvent(new Event("visibilitychange"));
        await advance(request, 1_000, 2);
      }
      await advance(request, 999, 2);
      await vi.advanceTimersByTimeAsync(1);
      await settleLitElement(sidebar);
      expect(request).toHaveBeenCalledTimes(3);
      expect(sidebar.textContent).toContain("Updated catalog");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    } else {
      for (const delay of [1_000, 2_000, 4_000]) {
        expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
        const requests = request.mock.calls.length;
        await advance(request, delay - 1, requests);
        await advance(request, 1, requests + 1);
      }
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Stable catalog");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus).toMatchObject({
        error: expect.any(String),
        stale: true,
      });
    }
    await advance(request, 119_999, outcome === "recovered" ? 3 : 5);
  });

  it("keeps agent startup quiet past three minutes and surfaces a later inspection failure", async () => {
    // JSDOM may already own a native frame when the catalog clock takes over.
    vi.useRealTimers();
    const pendingFrame = requestNativeFrame(() => undefined);
    vi.useFakeTimers(catalogClock);
    cancelNativeFrame(pendingFrame);
    const request = createGatewayRequestMock().mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Agent has not completed startup inspection. Run openclaw doctor --fix.",
        retryable: true,
        retryAfterMs: 250,
        details: { code: "agent-database-inspection-pending", agentId: "main" },
      }),
    );
    const { sidebar } = await mountTab(request);
    await vi.advanceTimersByTimeAsync(180_000);
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector('.sidebar-session-empty-hint--startup[role="status"]')?.textContent,
    ).toContain("Starting up");
    expect(sidebar.querySelector(".callout.danger")).toBeNull();
    expect(sidebar.textContent).not.toContain("doctor --fix");

    request.mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Inspection failed. Run openclaw doctor --fix.",
        retryable: false,
        details: { code: "agent-database-inspection-failed", agentId: "main" },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain("Starting up");
    expect(sidebar.querySelector(".sidebar-session-catalog-error")?.textContent).toContain(
      "Inspection failed. Run openclaw doctor --fix.",
    );
  });

  it.each(["hide", "remove"])(
    "retires a pending catalog retry when the sidebar must %s",
    async (action) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const setVisibility = visibilityFixture();
      const request = createGatewayRequestMock()
        .mockRejectedValueOnce(busy(5_000))
        .mockResolvedValue(page("recovered", "Recovered catalog"));
      const { sidebar } = await mountTab(request);
      if (action === "remove") {
        sidebar.remove();
      } else {
        setVisibility("hidden");
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(request).toHaveBeenCalledOnce();
      if (action === "hide") {
        setVisibility("visible");
        await advance(request, 4_999, 1);
        await advance(request, 1, 2);
        expect(sidebar.textContent).toContain("Recovered catalog");
      } else {
        await vi.advanceTimersByTimeAsync(300_000);
        expect(request).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["navigation", "collapsed", "view"] as const)(
    "pauses discovery while the %s surface hides catalogs",
    async (surface) => {
      const { request, sidebar } = await mountTab();
      if (surface === "navigation") {
        sidebar.navigationVisible = false;
      } else if (surface === "collapsed") {
        sidebar.navigationCollapsed = true;
      } else {
        sidebar.navigationView = "online";
      }
      await settleLitElement(sidebar);
      await advance(request, 125_000, 1);
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.sessions[0]?.name).toBe(
        "Stable catalog",
      );
      sidebar.navigationVisible = true;
      sidebar.navigationCollapsed = false;
      sidebar.navigationView = "sessions";
      await settleLitElement(sidebar);
      await advance(request, 5_000, 2);
      await advance(request, 5_000, 2);
      if (surface === "navigation") {
        sidebar.navigationVisible = false;
        await settleLitElement(sidebar);
        await sidebar.sessionData.refreshSessionCatalogs();
        expect(request).toHaveBeenCalledTimes(3);
        await advance(request, 125_000, 3);
      }
    },
  );

  it.each(["before", "after"] as const)(
    "fills a collapsed sidebar once and opens it %s the poll deadline",
    async (opening) => {
      const { request, sidebar } = await mountTab(undefined, (mounted) => {
        mounted.navigationCollapsed = true;
      });
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.sessions[0]?.name).toBe(
        "Stable catalog",
      );
      await advance(request, opening === "before" ? 10_000 : 125_000, 1);
      sidebar.navigationCollapsed = false;
      await settleLitElement(sidebar);
      if (opening === "before") {
        await advance(request, 109_000, 1);
        await advance(request, 1_000, 2);
      } else {
        await advance(request, 0, 2);
      }
    },
  );

  it("keeps the poll cadence when the sidebar opens before the next poll", async () => {
    const { request, sidebar } = await mountTab();
    sidebar.navigationCollapsed = true;
    await settleLitElement(sidebar);
    await advance(request, 30_000, 1);
    sidebar.navigationCollapsed = false;
    await settleLitElement(sidebar);
    await advance(request, 89_000, 1);
    await advance(request, 1_000, 2);
  });

  it.each(["document", "navigation"] as const)(
    "rechecks %s visibility after queued background admission",
    async (surface) => {
      const setVisibility = visibilityFixture();
      const { request, sidebar } = await mountTab();
      const context = sidebar.sessionData.context;
      context?.connectionBootstrap.setForegroundRoute(undefined);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      if (surface === "document") {
        setVisibility("hidden");
      } else {
        sidebar.navigationVisible = false;
        await settleLitElement(sidebar);
      }
      context?.connectionBootstrap.setForegroundRoute(null);
      await advance(request, 300_000, 1);
      if (surface === "document") {
        setVisibility("visible");
      } else {
        sidebar.navigationVisible = true;
        await settleLitElement(sidebar);
      }
      await advance(request, 5_000, 2);
    },
  );
});
