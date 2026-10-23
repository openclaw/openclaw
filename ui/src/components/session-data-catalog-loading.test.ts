/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
import {
  applySessionCatalogContinuation,
  applySessionCatalogHostEvent,
  loadMoreSessionCatalog,
  resetSessionCatalogConnection,
} from "./session-data-catalog.ts";

let loading: ReturnType<typeof createDeferred<void>>;
let entered: ReturnType<typeof createDeferred<void>>;
let replayFinished: ReturnType<typeof createDeferred<void>>;
function delayPageRuntime() {
  loading = createDeferred();
  entered = createDeferred();
  const completed = (replayFinished = createDeferred());
  // mock-delay: Hold module availability and observe the real replay's terminal promise.
  vi.doMock("./app-sidebar-session-catalog-pages.runtime.ts", async (original) => {
    entered.resolve();
    await loading.promise;
    const runtime =
      await original<typeof import("./app-sidebar-session-catalog-pages.runtime.ts")>();
    return {
      ...runtime,
      replayPublishedSessionCatalogHost(
        params: Parameters<typeof runtime.replayPublishedSessionCatalogHost>[0],
      ) {
        const pending = runtime.replayPublishedSessionCatalogHost(params);
        void pending.then(
          () => completed.resolve(),
          () => completed.resolve(),
        );
        return pending;
      },
    };
  });
  onTestFinished(() => loading.resolve());
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  delayPageRuntime();
});
afterEach(() => {
  vi.doUnmock("./app-sidebar-session-catalog-pages.runtime.ts");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  expect(request).toHaveBeenCalledTimes(1);
  return { sidebar, gateway, owner: sidebar.sessionData };
}

const head = () => catalogPage([{ threadId: "head", name: "Authorized head" }], "next");
const deep = () => catalogPage([{ threadId: "deep", name: "Authorized deep" }]);
function fresh(page: ReturnType<typeof catalogPage>) {
  page.catalogs[0]!.requiresFreshList = true;
  return page;
}

it("claims load-more before loading and merges against a later sibling publication", async () => {
  const initial = head();
  const peer = { ...deep().catalogs[0]!.hosts[0]!, hostId: "node:peer", label: "Peer" };
  initial.catalogs[0]!.hosts.push(peer);
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(deep());
  const { owner, gateway } = await mountTab(request);
  const pending = loadMoreSessionCatalog(owner, "codex", ["gateway:local"]);
  expect(owner.loadingMoreSessionCatalogIds.has("codex")).toBe(true);
  await entered.promise;
  await loadMoreSessionCatalog(owner, "codex", ["gateway:local"]);
  expect(request).toHaveBeenCalledTimes(2);
  const publishedPeer = {
    ...peer,
    sessions: [{ ...peer.sessions[0]!, threadId: "peer-new", name: "New sibling publication" }],
  };
  gateway.publishEvent("sessions.catalog.host", {
    progressId: (request.mock.calls[0]![1] as { progressId: string }).progressId,
    agentId: "main",
    catalog: { ...initial.catalogs[0]!, hosts: [publishedPeer] },
  });
  loading.resolve();
  await pending;
  const hosts = owner.sessionCatalogs[0]!.hosts;
  expect(
    hosts.find((host) => host.hostId === "gateway:local")!.sessions.map((row) => row.threadId),
  ).toEqual(["head", "deep"]);
  expect(
    hosts.find((host) => host.hostId === "node:peer")!.sessions.map((row) => row.threadId),
  ).toEqual(["peer-new"]);
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
});

it("does not publish a retired scope or clear the replacement scope's load-more claim", async () => {
  const replacement = catalogPage(
    [{ threadId: "replacement", name: "Replacement head" }],
    "new-next",
  );
  const nextPage = createDeferred<ReturnType<typeof catalogPage>>();
  onTestFinished(() => nextPage.resolve(deep()));
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(head())
    .mockResolvedValueOnce(deep())
    .mockResolvedValueOnce(replacement)
    .mockReturnValueOnce(nextPage.promise);
  const { owner } = await mountTab(request);
  const oldRead = loadMoreSessionCatalog(owner, "codex");
  await entered.promise;
  resetSessionCatalogConnection(owner);
  await owner.refreshSessionCatalogs();
  const newRead = loadMoreSessionCatalog(owner, "codex");
  expect(request).toHaveBeenCalledTimes(4);
  loading.resolve();
  await oldRead;
  expect(owner.loadingMoreSessionCatalogIds.has("codex")).toBe(true);
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions.map((row) => row.threadId)).toEqual([
    "replacement",
  ]);
  nextPage.resolve(catalogPage([{ threadId: "new-deep", name: "Replacement deep" }]));
  await newRead;
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions.map((row) => row.threadId)).toEqual([
    "replacement",
    "new-deep",
  ]);
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
});

it("preserves adoption while the load-more processor is unavailable", async () => {
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(head())
    .mockResolvedValueOnce(deep());
  const { owner } = await mountTab(request);
  const pending = loadMoreSessionCatalog(owner, "codex");
  await entered.promise;
  applySessionCatalogContinuation(owner, {
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "head",
    agentId: "main",
    sessionKey: "agent:main:adopted",
  });
  loading.resolve();
  await pending;
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toMatchObject([
    { threadId: "head", sessionKey: "agent:main:adopted" },
  ]);
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toHaveLength(1);
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
});

it("retains cursor-free authorization and explicit retry after delayed replay fails", async () => {
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(fresh(head()))
    .mockResolvedValueOnce(fresh(head()))
    .mockRejectedValueOnce(new Error("Source temporarily unavailable"))
    .mockResolvedValueOnce(
      fresh(catalogPage([{ threadId: "new-head", name: "New authorized head" }], "fresh-next")),
    )
    .mockResolvedValueOnce(
      fresh(catalogPage([{ threadId: "new-deep", name: "New authorized deep" }])),
    );
  const { owner } = await mountTab(request);
  const pending = loadMoreSessionCatalog(owner, "codex");
  await entered.promise;
  expect(request.mock.calls[1]![1]).not.toHaveProperty("cursors");
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toEqual([]);
  await loadMoreSessionCatalog(owner, "codex");
  expect(request).toHaveBeenCalledTimes(2);
  loading.resolve();
  await pending;
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
  expect(owner.sessionCatalogLive.canRetry(owner.sessionCatalogs[0]!)).toBe(true);
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toEqual([]);
  await loadMoreSessionCatalog(owner, "codex");
  expect(request.mock.calls[3]![1]).not.toHaveProperty("cursors");
  expect(request.mock.calls[4]![1]).toMatchObject({ cursors: { "gateway:local": "fresh-next" } });
  expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions.map((row) => row.threadId)).toEqual([
    "new-head",
    "new-deep",
  ]);
  expect(owner.sessionCatalogLive.canRetry(owner.sessionCatalogs[0]!)).toBe(false);
  expect(owner.loadingMoreSessionCatalogIds.size).toBe(0);
});

async function expandedSource() {
  const initial = fresh(head());
  const peer = { ...deep().catalogs[0]!.hosts[0]!, hostId: "node:peer", label: "Peer" };
  initial.catalogs[0]!.hosts.push(peer);
  const pending = fresh(catalogPage([]));
  pending.catalogs[0]!.hosts[0]!.pending = true;
  pending.catalogs[0]!.hosts.push(peer);
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(fresh(head()))
    .mockResolvedValueOnce(fresh(deep()))
    .mockResolvedValueOnce(pending);
  const tab = await mountTab(request);
  loading.resolve();
  await loadMoreSessionCatalog(tab.owner, "codex", ["gateway:local"]);
  expect(tab.owner.sessionCatalogs[0]!.hosts[0]!.sessions.map((row) => row.threadId)).toEqual([
    "head",
    "deep",
  ]);
  // Targeted reads retire the old progress stream; a new root owns this publication.
  await tab.owner.refreshSessionCatalogs();
  delayPageRuntime();
  const published = fresh(
    catalogPage([{ threadId: "published", name: "Published head" }], "published-next"),
  ).catalogs[0]!;
  applySessionCatalogHostEvent(tab.owner, {
    progressId: (request.mock.calls[3]![1] as { progressId: string }).progressId,
    agentId: "main",
    catalog: published,
  });
  await entered.promise;
  expect(request).toHaveBeenCalledTimes(4);
  return { ...tab, request, initial, peer };
}

it("replays a published host after loading without overwriting a sibling publication", async () => {
  const { owner, request, initial, peer } = await expandedSource();
  request.mockResolvedValueOnce(
    fresh(catalogPage([{ threadId: "published-deep", name: "Published deep" }])),
  );
  applySessionCatalogHostEvent(owner, {
    progressId: (request.mock.calls[3]![1] as { progressId: string }).progressId,
    agentId: "main",
    catalog: {
      ...initial.catalogs[0]!,
      hosts: [{ ...peer, sessions: [{ ...peer.sessions[0]!, threadId: "peer-new" }] }],
    },
  });
  loading.resolve();
  await replayFinished.promise;
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(5);
  expect(request.mock.calls[4]![1]).toMatchObject({
    catalogId: "codex",
    hostIds: ["gateway:local"],
    cursors: { "gateway:local": "published-next" },
  });
  const hosts = owner.sessionCatalogs[0]!.hosts;
  expect(
    hosts.find((host) => host.hostId === "gateway:local")!.sessions.map((row) => row.threadId),
  ).toEqual(["published", "published-deep"]);
  expect(
    hosts.find((host) => host.hostId === "node:peer")!.sessions.map((row) => row.threadId),
  ).toEqual(["peer-new"]);
});

it.each(["reset", "adoption"] as const)(
  "stops published replay and hidden discovery after %s during module loading",
  async (retirement) => {
    const { sidebar, owner, request } = await expandedSource();
    if (retirement === "reset") {
      sidebar.connected = false;
      resetSessionCatalogConnection(owner);
    } else {
      applySessionCatalogContinuation(owner, {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "published",
        agentId: "main",
        sessionKey: "agent:main:adopted",
      });
    }
    const discovery = vi.spyOn(owner, "sessionCatalogIdsWithoutVisibleRows");
    loading.resolve();
    await replayFinished.promise;
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(discovery).not.toHaveBeenCalled();
    if (retirement === "reset") {
      expect(owner.sessionCatalogs).toEqual([]);
    } else {
      expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toMatchObject([
        { threadId: "published", sessionKey: "agent:main:adopted" },
      ]);
      expect(owner.sessionCatalogs[0]!.hosts[0]!.sessions).toHaveLength(1);
    }
  },
);
