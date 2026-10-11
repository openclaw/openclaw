/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

async function mountTab(
  request = createGatewayRequestMock().mockResolvedValue(
    catalogPage([{ threadId: "stable", name: "Stable catalog" }]),
  ),
  events: string[] | undefined = ["sessions.catalog.changed"],
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.catalog.list"], events },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);
  return { sidebar, gateway, request };
}

describe("AppSidebar catalog event refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores session churn and unrelated agents while coalescing catalog event bursts", async () => {
    const { gateway, request } = await mountTab();
    gateway.publishEvent("sessions.changed", {
      agentId: "research",
      sessionKey: "agent:research:x",
    });
    gateway.publishEvent("sessions.catalog.changed", { agentId: "research" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a stable 30-second fallback when catalog changes are not advertised", async () => {
    const events = ["sessions.changed"];
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockResolvedValue(catalogPage([{ threadId: "discovered", name: "New catalog row" }]));
    const { gateway, sidebar } = await mountTab(request, events);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect.soft(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sidebar.textContent).toContain("New catalog row");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["recovered", "exhausted"] as const)("paces busy retries until %s", async (outcome) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "server busy",
      retryable: true,
      retryAfterMs: outcome === "recovered" ? 5_000 : 100,
    });
    const request = createGatewayRequestMock().mockResolvedValueOnce(
      catalogPage([{ threadId: "stable", name: "Stable catalog" }]),
    );
    if (outcome === "recovered") {
      request
        .mockRejectedValueOnce(error)
        .mockResolvedValue(catalogPage([{ threadId: "updated", name: "Updated catalog" }]));
    } else {
      request.mockRejectedValue(error);
    }
    const { gateway, sidebar } = await mountTab(request);
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Stable catalog");
    expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    if (outcome === "recovered") {
      for (let second = 0; second < 4; second += 1) {
        gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(request).toHaveBeenCalledTimes(2);
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await sidebar.updateComplete;
      expect(request).toHaveBeenCalledTimes(3);
      expect(sidebar.textContent).toContain("Updated catalog");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    } else {
      for (const delay of [1_000, 2_000, 4_000]) {
        expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
        expect(warning).not.toHaveBeenCalled();
        const requests = request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(request).toHaveBeenCalledTimes(requests);
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledTimes(requests + 1);
      }
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Stable catalog");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus).toMatchObject({
        error: expect.any(String),
        stale: true,
      });
      expect(warning).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(outcome === "recovered" ? 3 : 5);
  });

  it("keeps agent startup quiet past three minutes and surfaces a later inspection failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    await sidebar.updateComplete;
    expect(request.mock.calls.length).toBeGreaterThan(30);
    expect(
      sidebar.querySelector('.sidebar-session-empty-hint--startup[role="status"]')?.textContent,
    ).toContain("Starting up");
    expect(sidebar.querySelector(".callout.danger")).toBeNull();
    expect(sidebar.textContent).not.toContain("doctor --fix");
    expect(warning).not.toHaveBeenCalled();

    request.mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Inspection failed. Run openclaw doctor --fix.",
        retryable: false,
        details: { code: "agent-database-inspection-failed", agentId: "main" },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain("Starting up");
    expect(sidebar.querySelector(".sidebar-session-catalog-error")?.textContent).toContain(
      "Inspection failed. Run openclaw doctor --fix.",
    );
  });

  it.each(["hide", "remove"])(
    "retires a pending catalog retry when the sidebar must %s",
    async (action) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      let visibility: DocumentVisibilityState = "visible";
      const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const request = createGatewayRequestMock()
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "server busy",
            retryable: true,
            retryAfterMs: 5_000,
          }),
        )
        .mockResolvedValue(catalogPage([{ threadId: "recovered", name: "Recovered catalog" }]));
      try {
        const { sidebar } = await mountTab(request);
        if (action === "remove") {
          sidebar.remove();
        } else {
          visibility = "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
        }
        await vi.advanceTimersByTimeAsync(2_000);
        expect(request).toHaveBeenCalledOnce();
        if (action === "hide") {
          visibility = "visible";
          document.dispatchEvent(new Event("visibilitychange"));
          await vi.advanceTimersByTimeAsync(4_999);
          expect(request).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(1);
          expect(request).toHaveBeenCalledTimes(2);
          expect(sidebar.textContent).toContain("Recovered catalog");
        } else {
          await vi.advanceTimersByTimeAsync(300_000);
          expect(request).toHaveBeenCalledOnce();
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("rechecks visibility after queued background admission", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const { gateway, request, sidebar } = await mountTab();
      const context = sidebar.sessionData.context;
      context?.connectionBootstrap.setForegroundRoute(undefined);
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(5_000);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      context?.connectionBootstrap.setForegroundRoute(null);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(1);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
