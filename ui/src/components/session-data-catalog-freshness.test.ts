/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";
import { loadMoreSessionCatalog } from "./session-data-catalog.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

function fresh(ids: string[], nextCursor?: string) {
  const page = catalogPage(
    ids.map((threadId) => ({ threadId, name: threadId })),
    nextCursor,
  );
  page.catalogs[0]!.requiresFreshList = true;
  return page;
}

function freshHosts(
  ...hosts: Array<{
    id: string;
    rows: string[];
    cursor?: string;
    pending?: boolean;
  }>
) {
  const page = fresh([]);
  page.catalogs[0]!.hosts = hosts.map(({ id, rows, cursor, pending }) =>
    Object.assign(fresh(rows, cursor).catalogs[0]!.hosts[0]!, {
      hostId: id,
      label: id,
      ...(pending ? { pending } : {}),
    }),
  );
  return page;
}

async function mountTab(request: ReturnType<typeof createGatewayRequestMock>) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: {
        methods: ["sessions.catalog.list"],
        events: ["sessions.catalog.changed", "sessions.catalog.host"],
      },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  sidebar.connected = true;
  await settleLitElement(sidebar);
  await vi.advanceTimersByTimeAsync(0);
  return { owner: sidebar.sessionData, gateway, sidebar };
}

it("withdraws fresh rows and rejects a superseded refresh and its progressive publication", async () => {
  const oldRead = createDeferred<ReturnType<typeof fresh>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(fresh(["previous"]))
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValueOnce(fresh(["current"]));
  const { owner, gateway } = await mountTab(request);
  const pending = owner.refreshSessionCatalogs();
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions).toEqual([]);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBeUndefined();
  const oldProgress = (request.mock.calls[1]![1] as { progressId: string }).progressId;
  owner.sessionCatalogLive.clear();
  await owner.refreshSessionCatalogs();
  oldRead.resolve(fresh(["revoked"]));
  await pending;
  gateway.publishEvent("sessions.catalog.host", {
    agentId: "main",
    progressId: oldProgress,
    catalog: fresh(["revoked"]).catalogs[0],
  });
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
    "current",
  ]);
});

it("reauthorizes the expanded window before Load More and withdraws it on failure", async () => {
  const head = createDeferred<ReturnType<typeof fresh>>();
  const deep = createDeferred<ReturnType<typeof fresh>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(fresh(["revoked"], "old-next"))
    .mockReturnValueOnce(head.promise)
    .mockReturnValueOnce(deep.promise)
    .mockRejectedValueOnce(new Error("Source unavailable"))
    .mockResolvedValueOnce(fresh(["retry-head"], "retry-next"))
    .mockResolvedValueOnce(fresh(["retry-deep"], "still-more"));
  const { owner, sidebar } = await mountTab(request);
  const more = loadMoreSessionCatalog(owner, "codex");
  expect(request.mock.calls[1]?.[1]).not.toHaveProperty("cursors");
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions).toEqual([]);
  head.resolve(fresh(["new-head"], "new-next"));
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions).toEqual([]);
  deep.resolve(fresh(["new-deep"]));
  await more;
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
    "new-head",
    "new-deep",
  ]);
  await owner.refreshSessionCatalogs();
  expect(owner.sessionCatalogs[0]?.hosts[0]).toMatchObject({
    sessions: [],
    error: { message: "Source unavailable" },
  });
  expect(owner.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBeUndefined();
  expect(owner.sessionCatalogs[0]?.pending).not.toBe(true);
  await settleLitElement(sidebar);
  const retry = sidebar.querySelector<HTMLButtonElement>(
    '[data-session-catalog-load-more="codex"]',
  );
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
    "retry-head",
    "retry-deep",
  ]);
  expect(request).toHaveBeenCalledTimes(6);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("still-more");
});

it("replays an expanded window when a fresh host arrives after the aggregate response", async () => {
  const pendingPage = fresh([]);
  pendingPage.catalogs[0]!.hosts[0]!.pending = true;
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(fresh(["old-head"], "next"))
    .mockResolvedValueOnce(fresh(["old-head"], "next"))
    .mockResolvedValueOnce(fresh(["old-deep"]))
    .mockResolvedValueOnce(pendingPage)
    .mockResolvedValueOnce(fresh(["new-deep"]));
  const { owner, gateway } = await mountTab(request);
  await loadMoreSessionCatalog(owner, "codex");
  await owner.refreshSessionCatalogs();
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions).toEqual([]);
  gateway.publishEvent("sessions.catalog.host", {
    agentId: "main",
    progressId: (request.mock.calls[3]![1] as { progressId: string }).progressId,
    catalog: fresh(["new-head"], "next").catalogs[0],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
    "new-head",
    "new-deep",
  ]);
});

it("keeps a progressive host published while a sibling expanded page is still pending", async () => {
  const sibling = createDeferred<ReturnType<typeof freshHosts>>();
  const first = () =>
    freshHosts(
      { id: "a", rows: ["old-a"], cursor: "a-next" },
      { id: "b", rows: ["old-b"], cursor: "b-next" },
    );
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(first())
    .mockResolvedValueOnce(first())
    .mockResolvedValueOnce(freshHosts({ id: "a", rows: ["old-a-deep"] }))
    .mockResolvedValueOnce(freshHosts({ id: "b", rows: ["old-b-deep"] }))
    .mockResolvedValueOnce(
      freshHosts(
        { id: "a", rows: [], pending: true },
        { id: "b", rows: ["new-b"], cursor: "b-next" },
      ),
    )
    .mockReturnValueOnce(sibling.promise)
    .mockResolvedValueOnce(freshHosts({ id: "a", rows: ["new-a-deep"] }));
  const { owner, gateway } = await mountTab(request);
  await loadMoreSessionCatalog(owner, "codex");
  const refresh = owner.refreshSessionCatalogs();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(6);
  gateway.publishEvent("sessions.catalog.host", {
    agentId: "main",
    progressId: (request.mock.calls[4]![1] as { progressId: string }).progressId,
    catalog: freshHosts({ id: "a", rows: ["new-a"], cursor: "a-next" }).catalogs[0],
  });
  sibling.resolve(freshHosts({ id: "b", rows: ["new-b-deep"] }));
  await refresh;
  expect(
    owner.sessionCatalogs[0]?.hosts.map((host) => host.sessions.map((row) => row.threadId)),
  ).toEqual([
    ["new-a", "new-a-deep"],
    ["new-b", "new-b-deep"],
  ]);
});

it("rejects an ordinary hidden-page reply after a new root reuses its cursor", async () => {
  const page = createDeferred<ReturnType<typeof catalogPage>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(catalogPage([{ threadId: "first", name: "First" }]))
    .mockResolvedValueOnce(catalogPage([], "same-cursor"))
    .mockReturnValueOnce(page.promise)
    .mockResolvedValueOnce(
      catalogPage([{ threadId: "replacement", name: "Replacement" }], "same-cursor"),
    );
  const { owner } = await mountTab(request);
  const previous = owner.refreshSessionCatalogs();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3);
  await owner.refreshSessionCatalogs();
  page.resolve(catalogPage([{ threadId: "obsolete-page", name: "Obsolete" }]));
  await previous;
  expect(owner.sessionCatalogs[0]?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
    "replacement",
  ]);
  expect(owner.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("same-cursor");
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
});
