import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { catalogPage, createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";
import { mountCatalog, startCatalog, settleCatalog } from "./compact.test-support.ts";

describe("AppSidebar session catalog pagination", () => {
  beforeEach(() => vi.useFakeTimers());
  it("keeps the scheduled refresh when a visible page receives focus", async () => {
    const request = vi.fn().mockResolvedValue(catalogPage([]));
    await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);
    expect(request).toHaveBeenCalledOnce();

    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(50);
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(120_000 - 51);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "rescans after tab return during an active scan (discovery: %s)",
    async (discovery) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const pending = deferred<SessionsCatalogListResult>();
      const pendingDiscovery = deferred<SessionsCatalogListResult>();
      let fullScans = 0;
      const request = vi.fn((_method: string, params: { cursors?: Record<string, string> }) => {
        if (params.cursors) {
          return pendingDiscovery.promise;
        }
        fullScans += 1;
        return fullScans === 1
          ? pending.promise
          : Promise.resolve(catalogPage([{ threadId: "fresh", name: "Newly available session" }]));
      });
      const { sidebar } = await mountCatalog({
        request,
      } as unknown as GatewayBrowserClient);
      expect(request).toHaveBeenCalledOnce();

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledOnce();

      pending.resolve(catalogPage([], discovery ? "page-2" : undefined));
      await settleCatalog(sidebar);
      if (discovery) {
        expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
          agentId: "main",
          catalogId: "codex",
          hostIds: ["gateway:local"],
          cursors: { "gateway:local": "page-2" },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fullScans).toBe(1);
        pendingDiscovery.resolve(catalogPage([]));
        await settleCatalog(sidebar);
      }
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fullScans).toBe(1);
      await settleCatalog(sidebar, 1);
      expect(fullScans).toBe(2);
      expect(sidebar.textContent).toContain("Newly available session");
    },
  );

  it("stays paused when an in-flight catalog refresh finishes in a hidden tab", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const pending = deferred<SessionsCatalogListResult>();
    const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(catalogPage([]));
    const { sidebar } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);
    expect(request).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    pending.resolve(catalogPage([]));
    await settleCatalog(sidebar);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stays paused through a Gateway reconnect while the tab is hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const foregroundRequest = deferred<SessionsCatalogListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalogPage([]))
      .mockReturnValue(foregroundRequest.promise);
    const { sidebar, gateway } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);
    expect(request).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    gateway.publish({ phase: "reconnecting", hello: null });
    await sidebar.updateComplete;
    gateway.publish({
      phase: "connected",
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
    foregroundRequest.resolve(catalogPage([]));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not refresh when the Gateway does not advertise session catalogs", async () => {
    const request = vi.fn().mockResolvedValue(catalogPage([]));
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    await startCatalog(sidebar);

    globalThis.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(request).not.toHaveBeenCalled();
  });
});
