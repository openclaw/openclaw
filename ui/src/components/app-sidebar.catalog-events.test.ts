/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
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
    await vi.advanceTimersByTimeAsync(200);
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
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(200);
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
    await vi.advanceTimersByTimeAsync(200);
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
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rechecks visibility after queued background admission", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const { gateway, request, sidebar } = await mountTab();
      const context = sidebar.sessionData.context;
      context?.connectionBootstrap.setForegroundRoute(undefined);
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(200);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      context?.connectionBootstrap.setForegroundRoute(null);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(1);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(200);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
