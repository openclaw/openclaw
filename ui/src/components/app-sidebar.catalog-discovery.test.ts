/* @vitest-environment jsdom */

import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../packages/gateway-protocol/src/index.ts";
import { SessionsCatalogListParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogErrorPage,
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
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { mockDocumentVisibility } from "../test-helpers/mock-cleanup.ts";
import { setStoredSessionCatalogHidden } from "./app-sidebar-session-types.ts";
import "./app-sidebar.tsx";

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await settleLitElement(sidebar);
}

async function advance(sidebar: SidebarLifecycleState, milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settle(sidebar);
}

async function refresh(sidebar: SidebarLifecycleState, timers = true) {
  await sidebar.sessionData.refreshSessionCatalogs();
  await (timers ? settle(sidebar) : settleLitElement(sidebar));
}
const catalogError = (sidebar: SidebarLifecycleState) =>
  sidebar.querySelector('[data-session-catalog-error="codex"]');
function expectCatalogEmpty(sidebar: SidebarLifecycleState) {
  expect(
    sidebar.querySelector('[data-session-section="catalog:codex"] .sidebar-recent-sessions__list')
      ?.childElementCount,
  ).toBe(0);
}

function statusPage(scope: "host" | "catalog", status: "pending" | "error") {
  const page = catalogPage([]);
  const catalog = page.catalogs[0]!;
  const target = scope === "host" ? catalog.hosts[0]! : catalog;
  if (status === "pending") {
    target.pending = true;
  } else {
    target.error = { code: "UNAVAILABLE", message: "Discovery failed" };
  }
  if (scope === "catalog") {
    catalog.hosts = [];
  }
  return page;
}

function catalogParams(value: unknown) {
  if (!Value.Check(SessionsCatalogListParamsSchema, value)) {
    throw new Error("Invalid sessions.catalog.list request");
  }
  return value;
}

function discoveryGateway(request: GatewayRequestHandler) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.catalog.list"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return gateway;
}

function requestedCursors(request: ReturnType<typeof createGatewayRequestMock>) {
  return request.mock.calls.map(([, params]) => catalogParams(params).cursors?.["gateway:local"]);
}

async function mountDiscovery(
  request: GatewayRequestHandler,
  agentsList: typeof TWO_AGENTS | null = null,
) {
  const gateway = discoveryGateway(request);
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

  it("retains omitted hosts through catalog failure and pending recovery", async () => {
    const initial = catalogPage([{ threadId: "retained", name: "Retained conversation" }]);
    const request = createGatewayRequestMock().mockResolvedValue(initial);
    const { sidebar } = await mountDiscovery(request);
    const failed = statusPage("catalog", "error");
    const pending = statusPage("catalog", "pending");
    for (const update of [
      { result: pending, hasError: false, pending: true },
      { result: failed, hasError: true, pending: false },
      { result: pending, hasError: true, pending: true },
    ]) {
      request.mockResolvedValue(update.result);
      await refresh(sidebar);
      expect(sidebar.textContent).toContain("Retained conversation");
      expect(Boolean(catalogError(sidebar))).toBe(update.hasError);
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.pending === true).toBe(
        update.pending,
      );
    }
    request.mockResolvedValue(
      catalogPage([{ threadId: "replacement", name: "Replacement conversation" }]),
    );
    await refresh(sidebar);
    expect(sidebar.textContent).not.toContain("Retained conversation");
    expect(sidebar.textContent).toContain("Replacement conversation");
    expect(catalogError(sidebar)).toBeNull();
    request.mockResolvedValue(catalogPage([]));
    await refresh(sidebar);
    expect(sidebar.textContent).not.toContain("Replacement conversation");
    expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
  });
  it("retains only omitted nodes when their inventory fails, while local results remain authoritative", async () => {
    const initial = catalogPage([{ threadId: "paired", name: "Paired conversation" }]);
    const catalog = initial.catalogs[0]!;
    const makeHost = (hostId: string, threadId: string, name: string) => ({
      ...catalog.hosts[0]!,
      hostId,
      kind: hostId.startsWith("node:") ? ("node" as const) : ("gateway" as const),
      sessions: [{ ...catalog.hosts[0]!.sessions[0]!, threadId, name }],
    });
    const paired = makeHost("node:paired", "paired", "Paired conversation");
    const removed = makeHost("node:removed", "removed", "Removed conversation");
    const local = makeHost("gateway:local", "local", "Original local conversation");
    catalog.hosts = [{ ...paired, pending: true }, removed, local];
    const request = createGatewayRequestMock().mockResolvedValue(initial);
    const { sidebar } = await mountDiscovery(request);
    const updatedLocal = {
      ...local,
      sessions: [{ ...local.sessions[0]!, name: "Updated local conversation" }],
    };
    const registry = {
      ...paired,
      hostId: "node:registry",
      label: "Paired nodes",
      connected: false,
      sessions: [],
      error: { code: "NODE_LIST_FAILED", message: "Paired nodes could not be listed" },
    };
    request.mockResolvedValue({ catalogs: [{ ...catalog, hosts: [updatedLocal, registry] }] });
    await refresh(sidebar);
    expect(sidebar.textContent).toContain("Paired conversation");
    expect(sidebar.textContent).toContain("Removed conversation");
    expect(sidebar.textContent).toContain("Updated local conversation");
    expect(sidebar.textContent).not.toContain("Original local conversation");
    const retained = sidebar.sessionData.sessionCatalogs[0]?.hosts.find(
      (host) => host.hostId === paired.hostId,
    );
    expect(retained?.pending).not.toBe(true);
    expect(retained?.error?.code).toBe("NODE_LIST_FAILED");

    // Failure of one known node is not failure to enumerate other nodes.
    const failedNode = {
      ...paired,
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED", message: "Paired node read failed" },
    };
    request.mockResolvedValue({ catalogs: [{ ...catalog, hosts: [updatedLocal, failedNode] }] });
    await refresh(sidebar);
    expect(sidebar.textContent).toContain("Paired conversation");
    expect(sidebar.textContent).not.toContain("Removed conversation");
    request.mockResolvedValue({ catalogs: [{ ...catalog, hosts: [updatedLocal] }] });
    await refresh(sidebar);
    expect(sidebar.textContent).not.toContain("Paired conversation");
    expect(sidebar.textContent).toContain("Updated local conversation");
    expect(catalogError(sidebar)).toBeNull();
  });

  it("keeps catalog visibility current across moves, context replacement, and remounts", async () => {
    const request = createGatewayRequestMock().mockResolvedValue(
      catalogPage([{ threadId: "visible", name: "Visible catalog session" }]),
    );
    const { sidebar, provider, context, gatewayHarness } = await mountDiscovery(request);
    const catalog = () => sidebar.querySelector('[data-session-section="catalog:codex"]');
    expect(catalog()).not.toBeNull();
    setStoredSessionCatalogHidden("codex", true);
    await settle(sidebar);
    expect(catalog()).toBeNull();

    provider.setContext(createContext(gatewayHarness.gateway, context.sessions));
    await settle(sidebar);
    setStoredSessionCatalogHidden("codex", false);
    await settle(sidebar);
    expect(catalog()).not.toBeNull();

    sidebar.hostElement.remove();
    setStoredSessionCatalogHidden("codex", true);
    provider.append(sidebar.hostElement);
    await settle(sidebar);
    expect(catalog()).toBeNull();

    sidebar.hostElement.remove();
    await settle(sidebar);
    setStoredSessionCatalogHidden("codex", false);
    provider.append(sidebar.hostElement);
    await settle(sidebar);
    expect(catalog()).not.toBeNull();
  });

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
          sidebar.invalidate();
        } else {
          const gateway = discoveryGateway(currentRequest);
          provider.setContext(createContext(gateway.gateway, context.sessions, TWO_AGENTS));
        }
        await settleLitElement(sidebar);
        await advance(sidebar, 200);
        expect(currentRequest).toHaveBeenCalledTimes(1);
        expect(currentRequest.mock.lastCall?.[1]).toMatchObject({
          agentId: scope === "agent" ? "research" : "main",
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
        await vi.advanceTimersByTimeAsync(119_999);
        expect(currentRequest).toHaveBeenCalledTimes(1);
        await advance(sidebar, 1);
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
    expect(requestedCursors(request)).toEqual([
      undefined,
      ...Array.from({ length: 7 }, (_, index) => `page-${index + 2}`),
    ]);
  });

  it.each(["activation", "explicit"] as const)(
    "renews a finished empty sweep on %s invalidation",
    async (invalidation) => {
      let added = false;
      const request = createGatewayRequestMock((_method, params) => {
        const cursor = catalogParams(params).cursors?.["gateway:local"];
        return Promise.resolve(
          !cursor
            ? catalogPage([], "page-2")
            : cursor === "page-2"
              ? added
                ? catalogPage([{ threadId: "older", name: "Older session now visible" }])
                : catalogPage([], invalidation === "activation" ? "page-3" : undefined)
              : catalogPage([]),
        );
      });
      const { sidebar } = await mountDiscovery(request);
      added = true;
      if (invalidation === "activation") {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sidebar.textContent).not.toContain("Older session now visible");
        expect(request).toHaveBeenCalledTimes(3);
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(5_000);
      } else {
        sidebar.sessionData.invalidateSessionCatalogs();
      }
      await settle(sidebar);
      expect(sidebar.textContent).toContain("Older session now visible");
      expect(requestedCursors(request)).toEqual([
        undefined,
        "page-2",
        ...(invalidation === "activation" ? ["page-3"] : []),
        undefined,
        "page-2",
      ]);
    },
  );

  it.each(["request", "catalog", "missing host", "missing catalog"] as const)(
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
      expect(catalogError(sidebar)).not.toBeNull();
      expectCatalogEmpty(sidebar);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(3);
      const catalog = sidebar.sessionData.sessionCatalogs[0]!;
      expect((catalog.error ?? catalog.hosts[0]!.error)?.code).toBe(
        failure.startsWith("missing") ? "PAGINATION_FAILED" : "UNAVAILABLE",
      );

      failing = false;
      await refresh(sidebar, false);
      expect(requestedCursors(request).slice(-2)).toEqual([undefined, "page-3"]);
      expect(sidebar.textContent).toContain("Recovered discovery");
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error).toBeUndefined();
    },
  );

  it.each(["host", "catalog"] as const)(
    "pauses hidden discovery on a pending %s page and recovers on refresh",
    async (pendingScope) => {
      let pending = true;
      const request = createGatewayRequestMock((_method, params) => {
        if (!catalogParams(params).cursors) {
          return Promise.resolve(catalogPage([], "page-2"));
        }
        return Promise.resolve(
          pending
            ? statusPage(pendingScope, "pending")
            : catalogPage([{ threadId: "found", name: "Recovered pending discovery" }]),
        );
      });
      const { sidebar } = await mountDiscovery(request);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]).toMatchObject({
        pending: true,
        nextCursor: "page-2",
      });
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(request).toHaveBeenCalledTimes(2);
      pending = false;
      await advance(sidebar, 1);
      expect(requestedCursors(request)).toEqual([undefined, "page-2", undefined, "page-2"]);
      expect(sidebar.textContent).toContain("Recovered pending discovery");
    },
  );

  it("stops a two-page cursor cycle without a request loop", async () => {
    let revealed = false;
    const request = createGatewayRequestMock((_method, params) => {
      const cursor = catalogParams(params).cursors?.["gateway:local"];
      if (revealed && cursor === "page-a") {
        return Promise.resolve(catalogPage([{ threadId: "recovered", name: "Recovered session" }]));
      }
      return Promise.resolve(catalogPage([], cursor === "page-a" ? "page-b" : "page-a"));
    });
    const { sidebar } = await mountDiscovery(request);
    await advance(sidebar, 10_000);
    const host = sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!;
    expect(host.error?.code).toBe("PAGINATION_FAILED");
    const requests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(requests);
    expect(catalogError(sidebar)).not.toBeNull();
    expectCatalogEmpty(sidebar);
    revealed = true;
    await refresh(sidebar);
    expect(requestedCursors(request).slice(requests, requests + 2)).toEqual([undefined, "page-a"]);
    expect(sidebar.textContent).toContain("Recovered session");
  });

  it("retains an issued discovery page while hidden and resumes from its cursor", async () => {
    const setVisibility = mockDocumentVisibility();
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
    const { sidebar } = await mountDiscovery(request);
    expect(request).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    pending.resolve(catalogPage([], "page-3"));
    await settle(sidebar);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("page-3");
    setVisibility("visible");
    await advance(sidebar, 5_000);
    expect(sidebar.textContent).toContain("Visible again");
    expect(requestedCursors(request).at(-1)).toBe("page-3");
  });
});

const page = (number: number, label = "Original", nextCursor = `page-${number + 1}`) =>
  catalogPage([{ threadId: `thread-${number}`, name: `${label} ${number}` }], nextCursor);

function expandedRequest() {
  return vi
    .fn()
    .mockResolvedValueOnce(page(1))
    .mockResolvedValueOnce(page(2))
    .mockResolvedValueOnce(page(3));
}

async function loadMore(sidebar: SidebarLifecycleState) {
  const button = sidebar.querySelector<HTMLButtonElement>(
    '[data-session-catalog-load-more="codex"]',
  );
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  button?.click();
  await settle(sidebar);
}

async function mountExpanded(request: ReturnType<typeof expandedRequest>) {
  const mounted = await mountDiscovery(request);
  await loadMore(mounted.sidebar);
  await loadMore(mounted.sidebar);
  expect(request).toHaveBeenCalledTimes(3);
  expect(mounted.sidebar.textContent).toContain("Original 3");
  return mounted;
}

describe("AppSidebar expanded catalog refresh visibility", () => {
  let setVisibility: ReturnType<typeof mockDocumentVisibility>;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility = mockDocumentVisibility();
  });

  it("stops automatic replay after hiding during an expanded response and catches up once", async () => {
    const pending = deferred<SessionsCatalogListResult>();
    const request = expandedRequest();
    request.mockResolvedValueOnce(page(1, "Refreshed"));
    request.mockReturnValueOnce(pending.promise);
    request.mockImplementation((_method, params: { cursors?: Record<string, string> }) => {
      const cursor = params.cursors?.["gateway:local"];
      return Promise.resolve(
        page(cursor === "page-2" ? 2 : cursor === "page-3" ? 3 : 1, "Refreshed"),
      );
    });
    const { sidebar } = await mountExpanded(request);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    const issuedBeforeHide = 5;
    expect(request).toHaveBeenCalledTimes(issuedBeforeHide);

    setVisibility("hidden");
    pending.resolve(page(2, "Refreshed"));
    await settle(sidebar);
    await vi.advanceTimersByTimeAsync(60_000);
    expect.soft(request).toHaveBeenCalledTimes(issuedBeforeHide);
    const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
    expect(host?.sessions.map((row) => row.threadId)).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(host?.nextCursor).toBe("page-4");

    const baseCallsBeforeShow = request.mock.calls.filter(([, params]) => !params.cursors).length;
    const callsBeforeShow = request.mock.calls.length;
    setVisibility("visible");
    globalThis.dispatchEvent(new Event("focus"));
    await advance(sidebar, 5_000);
    expect(request.mock.calls.filter(([, params]) => !params.cursors)).toHaveLength(
      baseCallsBeforeShow + 1,
    );
    expect(request).toHaveBeenCalledTimes(callsBeforeShow + 3);
    expect(sidebar.textContent).toContain("Refreshed 1");
    expect(sidebar.textContent).toContain("Refreshed 2");
    expect(sidebar.textContent).toContain("Refreshed 3");
  });

  it("keeps resources retired during a detached update and resumes on reconnect", async () => {
    const observed = new Set<Element>();
    const observe = vi.fn((target: Element) => observed.add(target));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private targets = new Set<Element>();
        observe(target: Element) {
          this.targets.add(target);
          observe(target);
        }
        disconnect() {
          for (const target of this.targets) {
            observed.delete(target);
          }
          this.targets.clear();
        }
        unobserve(target: Element) {
          this.targets.delete(target);
          observed.delete(target);
        }
      },
    );
    let mounted: Awaited<ReturnType<typeof mountExpanded>> | undefined;
    try {
      const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
        const cursor = params.cursors?.["gateway:local"];
        return Promise.resolve(page(cursor === "page-2" ? 2 : cursor === "page-3" ? 3 : 1));
      });
      mounted = await mountExpanded(request);
      const { sidebar, provider } = mounted;
      const scrollBody = sidebar.querySelector(".sidebar-shell__body");
      expect(scrollBody).not.toBeNull();
      expect(observed.has(scrollBody!)).toBe(true);

      sidebar.invalidate();
      provider.remove();
      const timersAfterDetach = vi.getTimerCount();
      const observationsAfterDetach = observe.mock.calls.length;
      await settleLitElement(sidebar);
      // The bridge disposes its root after the same-turn reparenting window.
      // Disposal may retire existing timers; a detached owner must not add any.
      expect.soft(vi.getTimerCount()).toBeLessThanOrEqual(timersAfterDetach);
      expect.soft(observe).toHaveBeenCalledTimes(observationsAfterDetach);
      expect.soft(observed.has(scrollBody!)).toBe(false);

      document.body.append(provider);
      await settleLitElement(sidebar);
      await advance(sidebar, 200);
      expect(observed.has(sidebar.querySelector(".sidebar-shell__body")!)).toBe(true);
      expect(request).toHaveBeenCalledTimes(4);
      expect(sidebar.textContent).toContain("Original 1");
    } finally {
      mounted?.provider.remove();
      await mounted?.sidebar.updateComplete;
      // A red lifecycle assertion must not leave its retired resources in the next test.
      vi.clearAllTimers();
      vi.unstubAllGlobals();
    }
  });

  it("accepts an already-issued manual Load More error while hidden", async () => {
    const pending = deferred<SessionsCatalogListResult>();
    const request = expandedRequest().mockReturnValueOnce(pending.promise);
    const { sidebar } = await mountExpanded(request);
    await loadMore(sidebar);
    expect(request).toHaveBeenCalledTimes(4);
    setVisibility("hidden");
    pending.resolve(catalogErrorPage("Page failed"));
    await settle(sidebar);
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sidebar.textContent).toContain("Original 3");
    const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
    expect(host?.error?.message).toBe("Page failed");
    expect(host?.nextCursor).toBe("page-4");
  });
});
