/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
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
  afterEach(() => vi.useRealTimers());

  it("keeps four stable tabs idle for five minutes and refreshes each once per catalog event", async () => {
    const tabs = [];
    for (let index = 0; index < 4; index += 1) {
      tabs.push(await mountTab());
    }
    await vi.advanceTimersByTimeAsync(300_000);
    for (const { request, gateway } of tabs) {
      expect.soft(request).toHaveBeenCalledTimes(1);
      request.mockClear();
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    for (const { request, sidebar } of tabs) {
      expect(request).toHaveBeenCalledTimes(1);
      expect(sidebar.textContent).toContain("Stable catalog");
    }
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

  it.each([{ events: [] }, { events: ["sessions.changed"] }])(
    "keeps a stable 30-second fallback when catalog changes are not advertised (%j)",
    async ({ events }) => {
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
    },
  );

  it("paces a trailing event after a slow catalog request without overlapping reads", async () => {
    const pending = deferred<ReturnType<typeof catalogPage>>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(catalogPage([{ threadId: "updated", name: "Updated catalog" }]));
    const { gateway, sidebar } = await mountTab(request);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
    for (let second = 0; second < 3; second += 1) {
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(request).toHaveBeenCalledTimes(2);
    pending.resolve(catalogPage([]));
    await vi.advanceTimersByTimeAsync(8_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sidebar.textContent).toContain("Updated catalog");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("absorbs an event when an explicit refresh already reads the current catalog", async () => {
    const { gateway, sidebar, request } = await mountTab();
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await sidebar.sessionData.refreshSessionCatalogs();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("recovers a busy catalog without flashing an error or letting events bypass the retry delay", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([{ threadId: "stable", name: "Stable catalog" }]))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "server busy",
          retryable: true,
          retryAfterMs: 5_000,
        }),
      )
      .mockResolvedValue(catalogPage([{ threadId: "updated", name: "Updated catalog" }]));
    const { gateway, sidebar } = await mountTab(request);
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Stable catalog");
    expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
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
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("bounds busy retries and reports a persistent failure while preserving the catalog", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([{ threadId: "stable", name: "Stable catalog" }]))
      .mockRejectedValue(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "server busy",
          retryable: true,
          retryAfterMs: 100,
        }),
      );
    try {
      const { sidebar } = await mountTab(request);
      await sidebar.sessionData.refreshSessionCatalogs();
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
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(5);
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["hide", "remove"])(
    "retires a pending catalog retry when the sidebar must %s",
    async (action) => {
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
