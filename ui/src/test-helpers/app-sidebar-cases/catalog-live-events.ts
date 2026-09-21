import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { catalogPage, createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("does not queue another scan when focus returns during the startup scan", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledOnce();

      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
      pending.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the scheduled safety refresh when a visible page receives focus", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledOnce();

      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
      expect(request).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 51);
      expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(
    (["tab return", "catalog change"] as const).flatMap((activation) =>
      [false, true].map((discovery) => ({ activation, discovery })),
    ),
  )(
    "queues a fresh scan after $activation during an active scan (discovery: $discovery)",
    async ({ activation, discovery }) => {
      vi.useFakeTimers();
      let visibility: DocumentVisibilityState = "visible";
      const visibilitySpy = vi
        .spyOn(document, "visibilityState", "get")
        .mockImplementation(() => visibility);
      try {
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
            : Promise.resolve(
                catalogPage([{ threadId: "fresh", name: "Newly available session" }]),
              );
        });
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        gateway.publish({
          hello: {
            features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
        const { sidebar } = await mountSidebar(
          gateway.gateway,
          createSessions("main", ["agent:main:main"]),
        );
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledOnce();

        if (activation === "tab return") {
          visibility = "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
          visibility = "visible";
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
        }
        await vi.advanceTimersByTimeAsync(200);
        expect(request).toHaveBeenCalledOnce();

        pending.resolve(catalogPage([], discovery ? "page-2" : undefined));
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
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
          await vi.advanceTimersByTimeAsync(0);
          await sidebar.updateComplete;
        }
        await vi.advanceTimersByTimeAsync((discovery ? 3_000 : 1_000) - 1);
        expect(fullScans).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await sidebar.updateComplete;
        expect(fullScans).toBe(2);
        expect(sidebar.textContent).toContain("Newly available session");
      } finally {
        visibilitySpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("coalesces the visibility and focus events from one tab activation", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(199);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays paused when an in-flight catalog refresh finishes in a hidden tab", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
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

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(199);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays paused through a Gateway reconnect while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const foregroundRequest = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([]))
        .mockReturnValue(foregroundRequest.promise);
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
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

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      gateway.publish({ phase: "reconnecting", hello: null });
      await sidebar.updateComplete;
      gateway.publish({
        phase: "connected",
        hello: {
          features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(200);
      expect(request).toHaveBeenCalledTimes(2);
      foregroundRequest.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not refresh when the Gateway does not advertise session catalogs", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      globalThis.dispatchEvent(new Event("focus"));
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
