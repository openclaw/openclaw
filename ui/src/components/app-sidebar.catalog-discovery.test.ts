/* @vitest-environment jsdom */

import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsCatalogListParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogPage,
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
}

function catalogParams(value: unknown) {
  if (!Value.Check(SessionsCatalogListParamsSchema, value)) {
    throw new Error("Invalid sessions.catalog.list request");
  }
  return value;
}

async function mountDiscovery(
  request: GatewayRequestHandler,
  agentsList: typeof TWO_AGENTS | null = null,
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: {
      features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const mounted = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
    "panel",
    agentsList,
  );
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  await settle(mounted.sidebar);
  return { ...mounted, gatewayHarness: gateway };
}

describe("AppSidebar hidden catalog discovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["agent", "Gateway source"] as const)(
    "keeps the replacement scan active after discovery from the previous %s finishes",
    async (scope) => {
      const retiredPage = deferred<ReturnType<typeof catalogPage>>();
      const replacementScan = deferred<ReturnType<typeof catalogPage>>();
      const currentPage = catalogPage([{ threadId: "current", name: "Current session" }]);
      const currentRequest = createGatewayRequestMock().mockReturnValue(replacementScan.promise);
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(catalogPage([], "retired-page"))
        .mockReturnValueOnce(retiredPage.promise)
        .mockImplementation((method, params) => currentRequest(method, params));
      try {
        const { sidebar, provider, context } = await mountDiscovery(request, TWO_AGENTS);
        expect(request).toHaveBeenCalledTimes(2);
        expect(currentRequest).not.toHaveBeenCalled();

        if (scope === "agent") {
          context.agentSelection.state.selectedId = "research";
          context.agentSelection.state.scopeId = "research";
          sidebar.requestUpdate();
        } else {
          const gateway = createGatewayHarness(createTestGatewayClient(currentRequest));
          gateway.publish({
            hello: {
              features: {
                methods: ["sessions.catalog.list"],
                events: ["sessions.catalog.changed"],
              },
            } as ApplicationGatewaySnapshot["hello"],
          });
          provider.setContext(createContext(gateway.gateway, context.sessions, TWO_AGENTS));
        }
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(200);
        await settle(sidebar);
        expect(currentRequest).toHaveBeenCalledTimes(1);
        expect(currentRequest).toHaveBeenLastCalledWith("sessions.catalog.list", {
          agentId: scope === "agent" ? "research" : "main",
          limitPerHost: 40,
          progressId: expect.any(String),
          allowPartialResults: true,
        });

        retiredPage.resolve(
          catalogPage([{ threadId: "retired", name: "Retired session" }], "retired-next"),
        );
        await settle(sidebar);
        expect(sidebar.textContent).not.toContain("Retired session");
        globalThis.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(currentRequest).toHaveBeenCalledTimes(1);

        replacementScan.resolve(currentPage);
        await settle(sidebar);
        expect(sidebar.textContent).toContain("Current session");
        expect(sidebar.textContent).not.toContain("Retired session");
        await vi.advanceTimersByTimeAsync(599_999);
        expect(currentRequest).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle(sidebar);
        expect(currentRequest).toHaveBeenCalledTimes(2);
        expect(sidebar.textContent).toContain("Current session");
      } finally {
        retiredPage.resolve(catalogPage([]));
        replacementScan.resolve(currentPage);
      }
    },
  );

  it("finishes discovery beyond five empty pages without repeating the root request", async () => {
    const request = createGatewayRequestMock((_method, params) => {
      const cursor = catalogParams(params).cursors?.["gateway:local"];
      const page = cursor ? Number(cursor.slice("page-".length)) : 1;
      return Promise.resolve(
        page === 8
          ? catalogPage([{ threadId: "found", name: "Discovered session" }])
          : catalogPage([], `page-${page + 1}`),
      );
    });
    const { sidebar } = await mountDiscovery(request);
    expect(sidebar.textContent).toContain("Discovered session");
    expect(
      request.mock.calls.map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
    ).toEqual([undefined, ...Array.from({ length: 7 }, (_, index) => `page-${index + 2}`)]);
    expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(7);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(8);
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Discovered session");
    expect(request).toHaveBeenCalledTimes(16);
  });

  it.each(["row", "cursor"])(
    "rechecks fresh-head %s changes before continuing discovery",
    async (change) => {
      let changed = false;
      const request = createGatewayRequestMock((_method, params) => {
        const cursor = catalogParams(params).cursors?.["gateway:local"];
        if (!cursor) {
          return Promise.resolve(
            changed
              ? change === "row"
                ? catalogPage([{ threadId: "new", name: "New native session" }], "page-2")
                : catalogPage([], "new-page")
              : catalogPage([], "page-2"),
          );
        }
        return Promise.resolve(
          cursor === "new-page"
            ? catalogPage([{ threadId: "new", name: "New native session" }])
            : catalogPage([]),
        );
      });
      const { sidebar, gatewayHarness } = await mountDiscovery(request);
      changed = true;
      gatewayHarness.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(5_000);
      await settle(sidebar);
      expect(sidebar.textContent).toContain("New native session");
      expect(
        request.mock.calls.map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
      ).toEqual(
        change === "row"
          ? [undefined, "page-2", undefined]
          : [undefined, "page-2", undefined, "new-page"],
      );
    },
  );

  it("renews a finished empty sweep on invalidation so older membership changes remain discoverable", async () => {
    let added = false;
    const request = createGatewayRequestMock((_method, params) => {
      const cursor = catalogParams(params).cursors?.["gateway:local"];
      return Promise.resolve(
        !cursor
          ? catalogPage([], "page-2")
          : cursor === "page-2"
            ? added
              ? catalogPage([{ threadId: "older", name: "Older session now visible" }])
              : catalogPage([], "page-3")
            : catalogPage([]),
      );
    });
    const { sidebar, gatewayHarness } = await mountDiscovery(request);
    added = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sidebar.textContent).not.toContain("Older session now visible");
    expect(request).toHaveBeenCalledTimes(3);
    gatewayHarness.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(sidebar);
    expect(sidebar.textContent).toContain("Older session now visible");
    expect(
      request.mock.calls.map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
    ).toEqual([undefined, "page-2", "page-3", undefined, "page-2"]);
  });

  it("restarts empty discovery after an explicit catalog invalidation", async () => {
    let added = false;
    const request = createGatewayRequestMock((_method, params) =>
      Promise.resolve(
        !catalogParams(params).cursors
          ? catalogPage([], "page-2")
          : added
            ? catalogPage([{ threadId: "restored", name: "Restored native session" }])
            : catalogPage([]),
      ),
    );
    const { sidebar } = await mountDiscovery(request);
    added = true;
    sidebar.sessionData.invalidateSessionCatalogs();
    await settle(sidebar);
    expect(sidebar.textContent).toContain("Restored native session");
    expect(
      request.mock.calls.map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
    ).toEqual([undefined, "page-2", undefined, "page-2"]);
  });

  it.each(["request", "catalog", "host", "missing host", "missing catalog"] as const)(
    "stops automatic paging after a %s failure",
    async (failure) => {
      let failing = true;
      const request = createGatewayRequestMock((_method, params) => {
        if (!catalogParams(params).cursors) {
          return Promise.resolve(catalogPage([], "page-2"));
        }
        if (!failing) {
          return Promise.resolve(
            catalogPage([{ threadId: "recovered", name: "Recovered session" }]),
          );
        }
        if (failure === "request") {
          return Promise.reject(new Error("Discovery unavailable"));
        }
        const page = catalogPage([], "page-3");
        const error = { code: "UNAVAILABLE", message: "Discovery unavailable" };
        if (failure === "catalog") {
          page.catalogs[0]!.error = error;
        } else if (failure === "host") {
          page.catalogs[0]!.hosts[0]!.error = error;
        } else if (failure === "missing host") {
          page.catalogs[0]!.hosts = [];
        } else {
          page.catalogs = [];
        }
        return Promise.resolve(page);
      });
      const { sidebar } = await mountDiscovery(request);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
      const catalog = sidebar.sessionData.sessionCatalogs[0]!;
      expect((catalog.error ?? catalog.hosts[0]!.error)?.code).toBe(
        failure.startsWith("missing") ? "PAGINATION_FAILED" : "UNAVAILABLE",
      );
      expect(catalog.hosts[0]!.nextCursor).toBe("page-2");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);

      failing = false;
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Recovered session");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
    },
  );

  it.each(["request", "catalog", "host", "missing host", "missing catalog"] as const)(
    "preserves discovery progress and retries a %s page failure",
    async (failure) => {
      let failing = true;
      const request = createGatewayRequestMock((_method, params) => {
        const cursor = catalogParams(params).cursors?.["gateway:local"];
        if (!cursor) {
          return Promise.resolve(catalogPage([], "page-2"));
        }
        if (cursor === "page-2") {
          return Promise.resolve(catalogPage([], "page-3"));
        }
        const page = catalogPage([{ threadId: "found", name: "Recovered discovery" }]);
        if (failing) {
          const error = { code: "UNAVAILABLE", message: "Replay unavailable" };
          if (failure === "request") {
            return Promise.reject(new Error(error.message));
          }
          if (failure === "catalog") {
            page.catalogs[0]!.error = error;
          } else if (failure === "host") {
            page.catalogs[0]!.hosts[0]!.error = error;
          } else if (failure === "missing host") {
            page.catalogs[0]!.hosts = [];
          } else {
            page.catalogs = [];
          }
        }
        return Promise.resolve(page);
      });
      const { sidebar } = await mountDiscovery(request);
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("page-3");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);

      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      const catalog = sidebar.sessionData.sessionCatalogs[0]!;
      const host = catalog.hosts[0]!;
      expect((catalog.error ?? host.error)?.code).toBe(
        failure.startsWith("missing") ? "PAGINATION_FAILED" : "UNAVAILABLE",
      );
      expect(host.nextCursor).toBe("page-3");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
      expect(
        request.mock.calls
          .slice(-2)
          .map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
      ).toEqual([undefined, "page-3"]);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();

      failing = false;
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      expect(
        request.mock.calls
          .slice(-2)
          .map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
      ).toEqual([undefined, "page-3"]);
      expect(sidebar.textContent).toContain("Recovered discovery");
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error).toBeUndefined();
      expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(2);
    },
  );

  it.each([1, 2])("stops a %i-page cursor cycle without a request loop", async (cycleLength) => {
    let revealed = false;
    const request = createGatewayRequestMock((_method, params) => {
      const cursor = catalogParams(params).cursors?.["gateway:local"];
      if (revealed && cursor === "page-a") {
        return Promise.resolve(catalogPage([{ threadId: "recovered", name: "Recovered session" }]));
      }
      return Promise.resolve(
        catalogPage([], cursor === "page-a" && cycleLength === 2 ? "page-b" : "page-a"),
      );
    });
    const { sidebar } = await mountDiscovery(request);
    if (cycleLength === 2) {
      await vi.advanceTimersByTimeAsync(10_000);
      await settle(sidebar);
    }
    const host = sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!;
    expect(host.error?.code).toBe("PAGINATION_FAILED");
    const requests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(requests);
    expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
    revealed = true;
    await sidebar.sessionData.refreshSessionCatalogs();
    await settle(sidebar);
    expect(
      request.mock.calls
        .slice(requests, requests + 2)
        .map(([, params]) => catalogParams(params).cursors?.["gateway:local"]),
    ).toEqual([undefined, "page-a"]);
    expect(sidebar.textContent).toContain("Recovered session");
  });

  it("retains an issued discovery page while hidden and resumes from its cursor", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const pending = deferred<ReturnType<typeof catalogPage>>();
    const request = createGatewayRequestMock((_method, params) => {
      const cursor = catalogParams(params).cursors?.["gateway:local"];
      return cursor === "page-2"
        ? pending.promise
        : Promise.resolve(
            cursor === "page-3"
              ? catalogPage([{ threadId: "found", name: "Visible again" }])
              : catalogPage([], "page-2"),
          );
    });
    try {
      const { sidebar } = await mountDiscovery(request);
      expect(request).toHaveBeenCalledTimes(2);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve(catalogPage([], "page-3"));
      await settle(sidebar);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("page-3");
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      await settle(sidebar);
      expect(sidebar.textContent).toContain("Visible again");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-3" },
      });
    } finally {
      visibilitySpy.mockRestore();
    }
  });
});
