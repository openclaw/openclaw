/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
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
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { loadMoreSessionCatalog } from "./session-data-catalog.ts";
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

function visibilityFixture() {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  return (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

function sourceCatalogPage(rows: Parameters<typeof catalogPage>[0], cursor?: string) {
  const result = catalogPage(rows, cursor);
  for (const catalog of result.catalogs) {
    catalog.requiresFreshList = true;
  }
  return result;
}

async function mountTab(
  request = createGatewayRequestMock().mockResolvedValue(page("stable", "Stable catalog")),
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: gatewayHelloForMethods(["sessions.catalog.list"], ["operator.read"]),
  });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
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

  it.each(["pending", "failed", "success"] as const)(
    "withdraws source-authorized rows before a %s refresh settles",
    async (outcome) => {
      const shared = sourceCatalogPage([{ threadId: "private", name: "Source-authorized row" }]);
      const pending = deferred<typeof shared>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(shared)
        .mockReturnValueOnce(pending.promise);
      const { sidebar } = await mountTab(request);
      expect(sidebar.textContent).toContain("Source-authorized row");
      const refresh = sidebar.sessionData.refreshSessionCatalogs();
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect.soft(sidebar.textContent).not.toContain("Source-authorized row");
      if (outcome === "failed") {
        pending.reject(new Error("Source unavailable"));
      } else {
        const result = outcome === "success" ? shared : sourceCatalogPage([]);
        if (outcome === "pending") {
          for (const catalog of result.catalogs) {
            for (const host of catalog.hosts) {
              host.pending = true;
            }
          }
        }
        pending.resolve(result);
      }
      await refresh;
      await settleLitElement(sidebar);
      expect(sidebar.textContent?.includes("Source-authorized row")).toBe(outcome === "success");
    },
  );

  it.each(["success", "failed", "revoked"] as const)(
    "reauthorizes the whole source window during %s load-more",
    async (outcome) => {
      const sourcePage = sourceCatalogPage;
      const warm = sourcePage(
        [{ threadId: "old", name: "Previously authorized head" }],
        "old-cursor",
      );
      const refreshed = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(refreshed.promise)
        .mockResolvedValue(sourcePage([{ threadId: "older", name: "Fresh older row" }]));
      const { sidebar } = await mountTab(request);
      const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Previously authorized head");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
      });
      if (outcome === "failed") {
        refreshed.reject(new Error("Source unavailable"));
      } else {
        refreshed.resolve(
          outcome === "revoked"
            ? sourcePage([])
            : sourcePage([{ threadId: "fresh", name: "Fresh authorized head" }], "fresh-cursor"),
        );
      }
      await more;
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Previously authorized head");
      if (outcome === "success") {
        expect(sidebar.textContent).toContain("Fresh authorized head");
        expect(sidebar.textContent).toContain("Fresh older row");
        expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
          agentId: "main",
          catalogId: "codex",
          hostIds: ["gateway:local"],
          cursors: { "gateway:local": "fresh-cursor" },
        });
      } else {
        expect(sidebar.textContent).not.toContain("Fresh older row");
        expect(request).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("advances source-authorized discovery across multiple empty pages", async () => {
    const sourcePage = sourceCatalogPage;
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(sourcePage([{ threadId: "old", name: "Old head" }], "page-2"))
      .mockResolvedValueOnce(sourcePage([], "page-2"))
      .mockResolvedValueOnce(sourcePage([], "page-3"))
      .mockResolvedValueOnce(sourcePage([], "page-2"))
      .mockResolvedValueOnce(sourcePage([], "page-3"))
      .mockResolvedValueOnce(sourcePage([{ threadId: "visible", name: "Visible later page" }]));
    const { sidebar } = await mountTab(request);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", undefined, true);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", undefined, true);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Visible later page");
    expect(request).toHaveBeenCalledTimes(6);
    expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
      agentId: "main",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      cursors: { "gateway:local": "page-3" },
    });
  });

  it.each(["revoked", "failed"] as const)(
    "rejects old host publications during and after %s source load-more",
    async (outcome) => {
      const warm = sourceCatalogPage([{ threadId: "old", name: "Old source publication" }], "next");
      const next = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(next.promise);
      const { sidebar, gateway } = await mountTab(request);
      const progressId = (request.mock.calls[0]![1] as { progressId: string }).progressId;
      const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: warm.catalogs[0],
      });
      await settleLitElement(sidebar);
      expect.soft(sidebar.textContent).not.toContain("Old source publication");
      if (outcome === "failed") {
        next.reject(new Error("Source unavailable"));
      } else {
        next.resolve(sourceCatalogPage([]));
      }
      await more;
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: warm.catalogs[0],
      });
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old source publication");
    },
  );

  it("does not let an older root result overwrite source load-more withdrawal", async () => {
    const warm = sourceCatalogPage([{ threadId: "old", name: "Old root publication" }], "next");
    const root = deferred<typeof warm>();
    const next = deferred<typeof warm>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(warm)
      .mockReturnValueOnce(root.promise)
      .mockReturnValueOnce(next.promise);
    const { sidebar } = await mountTab(request);
    const refresh = sidebar.sessionData.refreshSessionCatalogs();
    const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
    root.resolve(warm);
    await refresh;
    await settleLitElement(sidebar);
    expect.soft(sidebar.textContent).not.toContain("Old root publication");
    next.resolve(sourceCatalogPage([]));
    await more;
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain("Old root publication");
  });

  it.each(["head", "deeper"] as const)(
    "keeps both hosts when late sibling progress arrives during the fresh %s request",
    async (phase) => {
      const warm = sourceCatalogPage([{ threadId: "old-a", name: "Old A" }], "old-next");
      const hostA = warm.catalogs[0]!.hosts[0]!;
      const hostB = {
        ...hostA,
        hostId: "node:b",
        label: "Host B",
        pending: true,
        nextCursor: undefined,
        sessions: [],
      };
      warm.catalogs[0]!.hosts.push(hostB);
      const head = sourceCatalogPage([{ threadId: "fresh-a", name: "Fresh A" }], "fresh-next");
      const deep = sourceCatalogPage([{ threadId: "deep-a", name: "Deep A" }]);
      const held = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(phase === "head" ? held.promise : Promise.resolve(head))
        .mockReturnValueOnce(phase === "deeper" ? held.promise : Promise.resolve(deep));
      const { sidebar, gateway } = await mountTab(request);
      const progressId = (request.mock.calls[0]![1] as { progressId: string }).progressId;
      const more = loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old A");
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: {
          ...warm.catalogs[0],
          hosts: [
            {
              ...hostB,
              pending: false,
              sessions: [{ ...hostA.sessions[0]!, threadId: "fresh-b", name: "Fresh B" }],
            },
          ],
        },
      });
      held.resolve(phase === "head" ? head : deep);
      await more;
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Fresh A");
      expect(sidebar.textContent).toContain("Deep A");
      expect(sidebar.textContent).toContain("Fresh B");
      expect(sidebar.textContent).not.toContain("Old A");
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(0);
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["success", "revoked", "failed", "new-root"] as const)(
    "replays only currently authorized expanded pages after late host progress: %s",
    async (outcome) => {
      const head = sourceCatalogPage([{ threadId: "head", name: "Authorized head" }], "next");
      const oldDeep = sourceCatalogPage([{ threadId: "old-deep", name: "Old deeper row" }]);
      const pending = sourceCatalogPage([]);
      pending.catalogs[0]!.hosts[0]!.pending = true;
      const held = deferred<typeof head>();
      void held.promise.catch(() => undefined);
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(oldDeep)
        .mockResolvedValueOnce(pending)
        .mockReturnValueOnce(held.promise)
        .mockResolvedValue(sourceCatalogPage([]));
      const { sidebar, gateway } = await mountTab(request);
      await loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Old deeper row");
      await sidebar.sessionData.refreshSessionCatalogs();
      const progressId = (request.mock.calls[3]![1] as { progressId: string }).progressId;
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: head.catalogs[0],
      });
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old deeper row");
      expect(request).toHaveBeenCalledTimes(5);
      if (outcome === "new-root") {
        await sidebar.sessionData.refreshSessionCatalogs();
      }
      if (outcome === "failed") {
        held.reject(new Error("Source unavailable"));
      } else {
        held.resolve(
          sourceCatalogPage(
            outcome === "revoked" ? [] : [{ threadId: "fresh-deep", name: "Fresh deeper row" }],
          ),
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old deeper row");
      expect(sidebar.textContent?.includes("Fresh deeper row")).toBe(outcome === "success");
      expect(sidebar.textContent?.includes("Authorized head")).toBe(
        outcome === "success" || outcome === "revoked",
      );
      if (outcome === "failed") {
        expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error?.message).toBe(
          "Source unavailable",
        );
      }
    },
  );

  it("ignores session churn while coalescing tab activation bursts", async () => {
    const { gateway, request } = await mountTab();
    gateway.publishEvent("sessions.changed", {
      agentId: "research",
      sessionKey: "agent:research:x",
    });
    await advance(request, 5_000, 1);
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await advance(request, 5_000, 1);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(request, 5_000, 2);
  });

  it("discovers native sessions every two minutes while visible", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockResolvedValue(page("discovered", "New catalog row"));
    const { gateway, sidebar } = await mountTab(request);
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(119_999);
    expect.soft(request).toHaveBeenCalledTimes(1);
    await advance(request, 1, 2);
    expect(sidebar.textContent).toContain("New catalog row");
    await advance(request, 119_999, 2);
    await advance(request, 1, 3);
    await advance(request, 6 * 60_000, 6);
  });

  it.each(["recovered", "exhausted"] as const)("paces busy retries until %s", async (outcome) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
        expect(warning).not.toHaveBeenCalled();
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
      expect(warning).toHaveBeenCalledOnce();
    }
    await advance(request, 119_999, outcome === "recovered" ? 3 : 5);
  });

  it("keeps agent startup quiet past three minutes and surfaces a later inspection failure", async () => {
    // JSDOM may already own a native frame when the catalog clock takes over.
    vi.useRealTimers();
    const pendingFrame = requestNativeFrame(() => undefined);
    vi.useFakeTimers(catalogClock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  it("rechecks visibility after queued background admission", async () => {
    const setVisibility = visibilityFixture();
    const { request, sidebar } = await mountTab();
    const context = sidebar.sessionData.context;
    context?.connectionBootstrap.setForegroundRoute(undefined);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    setVisibility("hidden");
    context?.connectionBootstrap.setForegroundRoute(null);
    await advance(request, 300_000, 1);
    setVisibility("visible");
    await advance(request, 5_000, 2);
  });
});
