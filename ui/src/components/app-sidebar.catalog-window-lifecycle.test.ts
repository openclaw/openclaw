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
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";
import {
  applySessionCatalogContinuation,
  loadMoreSessionCatalog,
  resetSessionCatalogConnection,
} from "./session-data-controller-catalog.ts";

const catalogClock: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ["setTimeout", "clearTimeout", "Date"],
};

function sourceCatalogPage(rows: Parameters<typeof catalogPage>[0], cursor?: string) {
  const page = catalogPage(rows, cursor);
  for (const catalog of page.catalogs) {
    catalog.requiresFreshList = true;
  }
  return page;
}

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
  await settleLitElement(sidebar);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);
  return { sidebar, gateway, request };
}

describe("late expanded host publication while root discovery is active", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([true, false])("restores authorized depth, publishDuringDiscovery=%s", async (during) => {
    const head = sourceCatalogPage([{ threadId: "head", name: "Authorized head" }], "next");
    const deep = sourceCatalogPage([{ threadId: "deep", name: "Authorized deep" }]);
    const pending = sourceCatalogPage([]);
    pending.catalogs[0]!.hosts[0]!.pending = true;
    const other = catalogPage([], "other-next");
    other.catalogs[0]!.id = "other";
    other.catalogs[0]!.label = "Other catalog";
    const found = catalogPage([{ threadId: "found", name: "Other found" }]);
    found.catalogs[0]!.id = "other";
    found.catalogs[0]!.label = "Other catalog";
    pending.catalogs.push(other.catalogs[0]!);
    const discovery = deferred<typeof found>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce(deep)
      .mockResolvedValueOnce(pending)
      .mockReturnValueOnce(discovery.promise)
      .mockResolvedValue(deep);
    const { sidebar, gateway } = await mountTab(request);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Authorized deep");
    const refreshing = sidebar.sessionData.refreshSessionCatalogs();
    await vi.advanceTimersByTimeAsync(0);
    await settleLitElement(sidebar);
    expect(request).toHaveBeenCalledTimes(5);
    expect(sidebar.sessionData.sessionCatalogLive.refetching).toBe(false);
    expect(sidebar.sessionData.sessionCatalogLive.requestGeneration).not.toBeNull();
    const progressId = (request.mock.calls[3]![1] as { progressId: string }).progressId;
    if (!during) {
      discovery.resolve(found);
      await refreshing;
    }
    gateway.publishEvent("sessions.catalog.host", {
      progressId,
      agentId: "main",
      catalog: head.catalogs[0],
    });
    await vi.advanceTimersByTimeAsync(0);
    discovery.resolve(found);
    await refreshing;
    await vi.advanceTimersByTimeAsync(5_000);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Other found");
    expect(sidebar.textContent).toContain("Authorized head");
    expect(sidebar.textContent).toContain("Authorized deep");
  });
});

describe("targeted fresh-window retry after source failure", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(
    ["host", "deeper", "transport", "catalog", "deeper-host"].flatMap((mode) => [
      { mode, peer: true },
      { mode, peer: false },
    ]),
  )("preserves explicit retry after $mode failure, peer=$peer", async ({ mode, peer }) => {
    const head = sourceCatalogPage([{ threadId: "head", name: "Authorized head" }], "next");
    const failed = sourceCatalogPage([]);
    failed.catalogs[0]!.hosts[0]!.error = {
      code: "UNAVAILABLE",
      message: "Source temporarily unavailable",
    };
    const initial = structuredClone(head);
    if (peer) {
      initial.catalogs[0]!.hosts.push({
        ...initial.catalogs[0]!.hosts[0]!,
        hostId: "node:peer",
        label: "Peer",
        nextCursor: undefined,
        sessions: [
          {
            threadId: "peer",
            name: "Peer still visible",
            status: "idle",
            archived: false,
            canContinue: true,
            canArchive: true,
          },
        ],
      });
    }
    const request = createGatewayRequestMock().mockResolvedValueOnce(initial);
    if (mode === "host") {
      request.mockResolvedValueOnce(failed);
    } else if (mode === "catalog") {
      request.mockResolvedValueOnce({
        catalogs: [{ ...head.catalogs[0]!, error: failed.catalogs[0]!.hosts[0]!.error }],
      });
    } else if (mode === "deeper-host") {
      request.mockResolvedValueOnce(head).mockResolvedValueOnce(failed);
    } else if (mode === "deeper") {
      request
        .mockResolvedValueOnce(head)
        .mockRejectedValueOnce(new Error("Source temporarily unavailable"));
    } else {
      request.mockRejectedValueOnce(new Error("Source temporarily unavailable"));
    }
    request
      .mockResolvedValueOnce(
        sourceCatalogPage(
          [{ threadId: "fresh-head", name: "Fresh authorized head" }],
          "fresh-cursor",
        ),
      )
      .mockResolvedValue(
        sourceCatalogPage([{ threadId: "fresh-deep", name: "Fresh authorized deep" }]),
      );
    const { sidebar } = await mountTab(request);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
    await settleLitElement(sidebar);
    const failedCallCount = request.mock.calls.length;
    const button = sidebar.querySelector('[data-session-catalog-load-more="codex"]');
    expect(sidebar.textContent).not.toContain("Authorized head");
    expect(sidebar.textContent).not.toContain("Authorized deep");
    expect(sidebar.textContent?.includes("Peer still visible")).toBe(peer);
    expect(button).not.toBeNull();
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Missing catalog retry button");
    }
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    await settleLitElement(sidebar);
    expect(request.mock.calls.length).toBe(failedCallCount + 2);
    expect(request.mock.calls[failedCallCount]![1]).not.toHaveProperty("cursors");
    expect(request.mock.calls[failedCallCount + 1]![1]).toMatchObject({
      cursors: { "gateway:local": "fresh-cursor" },
    });
    expect(sidebar.textContent).toContain("Fresh authorized deep");
    expect(sidebar.textContent).not.toContain("Authorized head");
  });
});

describe("source window lifecycle boundaries", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["head", "replay"] as const)(
    "accepts late source publication during root %s without another root read",
    async (phase) => {
      const head = sourceCatalogPage([{ threadId: "head", name: "Initial head" }], "old-next");
      const deep = sourceCatalogPage([{ threadId: "old", name: "Old deeper row" }]);
      const fresh = sourceCatalogPage(
        [{ threadId: "fresh", name: "Fresh published head" }],
        "fresh-next",
      );
      const freshDeep = sourceCatalogPage([
        { threadId: "fresh-deep", name: "Fresh published deep" },
      ]);
      const pending = sourceCatalogPage([]);
      pending.catalogs[0]!.hosts[0]!.pending = true;
      const root = deferred<typeof head>();
      const replay = deferred<typeof deep>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(deep)
        .mockReturnValueOnce(root.promise);
      if (phase === "replay") {
        request.mockReturnValueOnce(replay.promise);
      }
      request.mockResolvedValue(freshDeep);
      const { sidebar, gateway } = await mountTab(request);
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      const refreshing = sidebar.sessionData.refreshSessionCatalogs();
      const progressId = (request.mock.calls[3]![1] as { progressId: string }).progressId;
      if (phase === "replay") {
        root.resolve(head);
        await vi.advanceTimersByTimeAsync(0);
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: fresh.catalogs[0],
      });
      root.resolve(pending);
      replay.resolve(deep);
      await refreshing;
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Fresh published head");
      expect(sidebar.textContent).toContain("Fresh published deep");
      expect(sidebar.textContent).not.toContain("Old deeper row");
      expect(
        request.mock.calls.filter(
          ([, params]) => params !== null && typeof params === "object" && "progressId" in params,
        ),
      ).toHaveLength(2);
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "fresh-next" },
      });
    },
  );

  it.each(["pending", "repeated", "revoked"] as const)(
    "stops fresh replay at %s without reviving the old window",
    async (outcome) => {
      const head = sourceCatalogPage([{ threadId: "old", name: "Old authorized row" }], "old-next");
      const fresh = sourceCatalogPage([{ threadId: "fresh", name: "Fresh head" }], "fresh-next");
      const stopped = sourceCatalogPage([]);
      if (outcome === "pending") {
        stopped.catalogs[0]!.hosts[0]!.pending = true;
      }
      if (outcome === "repeated") {
        stopped.catalogs[0]!.hosts[0]!.nextCursor = "fresh-next";
      }
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(fresh)
        .mockResolvedValueOnce(stopped);
      const { sidebar } = await mountTab(request);
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old authorized row");
      expect(sidebar.textContent?.includes("Fresh head")).toBe(outcome === "revoked");
      expect(sidebar.querySelector('[data-session-catalog-load-more="codex"]')).toBeNull();
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["replacement", "reset"] as const)(
    "rejects an old retry completion after %s",
    async (outcome) => {
      const head = sourceCatalogPage([{ threadId: "old", name: "Old authorized row" }], "next");
      const retry = deferred<typeof head>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockRejectedValueOnce(new Error("Temporary source failure"))
        .mockReturnValueOnce(retry.promise)
        .mockResolvedValue(sourceCatalogPage([]));
      const { sidebar } = await mountTab(request);
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      const pending = sidebar.sessionData.loadMoreSessionCatalog("codex");
      if (outcome === "reset") {
        resetSessionCatalogConnection(sidebar.sessionData);
      } else {
        await sidebar.sessionData.refreshSessionCatalogs();
      }
      retry.resolve(sourceCatalogPage([{ threadId: "retired", name: "Retired retry row" }]));
      await pending;
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old authorized row");
      expect(sidebar.textContent).not.toContain("Retired retry row");
    },
  );
});

describe("expanded source recovery", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["root-error", "root-replay-error", "publication-replay-error"] as const)(
    "recovers the saved window after %s",
    async (mode) => {
      const head = sourceCatalogPage([{ threadId: "head", name: "Source head" }], "next");
      const deep = sourceCatalogPage([{ threadId: "deep", name: "Old deeper row" }]);
      const current = sourceCatalogPage([
        { threadId: "current", name: "Currently authorized deep" },
      ]);
      const pending = sourceCatalogPage([]);
      pending.catalogs[0]!.hosts[0]!.pending = true;
      const root = deferred<typeof head>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(deep)
        .mockReturnValueOnce(root.promise);
      if (mode !== "root-error") {
        request.mockRejectedValueOnce(new Error("Transient page failure"));
      } else {
        request.mockResolvedValueOnce(current);
      }
      const { sidebar, gateway } = await mountTab(request);
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      const refreshing = sidebar.sessionData.refreshSessionCatalogs();
      const progressId = (request.mock.calls[3]![1] as { progressId: string }).progressId;
      if (mode === "root-error") {
        gateway.publishEvent("sessions.catalog.host", {
          progressId,
          agentId: "main",
          catalog: head.catalogs[0],
        });
        root.reject(new Error("Aggregate temporarily unavailable"));
      } else {
        root.resolve(mode === "root-replay-error" ? head : pending);
      }
      await refreshing;
      if (mode === "publication-replay-error") {
        gateway.publishEvent("sessions.catalog.host", {
          progressId,
          agentId: "main",
          catalog: head.catalogs[0],
        });
        await vi.advanceTimersByTimeAsync(0);
      }
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old deeper row");
      if (mode !== "root-error") {
        expect(sidebar.textContent).not.toContain("Source head");
        request.mockResolvedValueOnce(head).mockResolvedValueOnce(current);
        const retry = sidebar.querySelector<HTMLButtonElement>(
          '[data-session-catalog-load-more="codex"]',
        );
        expect(retry).not.toBeNull();
        retry!.click();
        await vi.advanceTimersByTimeAsync(0);
        await settleLitElement(sidebar);
        expect(request.mock.calls.at(-2)![1]).not.toHaveProperty("cursors");
      }
      expect(sidebar.textContent).toContain("Currently authorized deep");
      expect(sidebar.textContent).not.toContain("Old deeper row");
    },
  );
});

describe("fresh retry intent across root replacement", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(
    ["transport", "host"].flatMap((failure) => [
      { failure, previousRetry: true },
      { failure, previousRetry: false },
    ]),
  )(
    "keeps safe intent after root $failure, existingRetry=$previousRetry",
    async ({ failure, previousRetry }) => {
      const initial = sourceCatalogPage(
        [{ threadId: "old", name: "Previously authorized" }],
        "old-cursor",
      );
      const failed = sourceCatalogPage([]);
      failed.catalogs[0]!.hosts[0]!.error = { code: "UNAVAILABLE", message: "Temporary failure" };
      const current = sourceCatalogPage(
        [{ threadId: "current", name: "Current authorized head" }],
        "current-cursor",
      );
      const deep = sourceCatalogPage([{ threadId: "deep", name: "Current authorized deep" }]);
      const request = createGatewayRequestMock().mockResolvedValueOnce(initial);
      const { sidebar } = await mountTab(request);
      if (previousRetry) {
        request.mockResolvedValueOnce(failed);
        await sidebar.sessionData.loadMoreSessionCatalog("codex");
      }
      if (failure === "transport") {
        request.mockRejectedValueOnce(new Error("Root temporarily unavailable"));
      } else {
        request.mockResolvedValueOnce(failed);
      }
      await sidebar.sessionData.refreshSessionCatalogs();
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Previously authorized");
      expect(
        sidebar.sessionData.sessionCatalogLive.canRetry(sidebar.sessionData.sessionCatalogs[0]!),
      ).toBe(true);
      const retry = sidebar.querySelector<HTMLButtonElement>(
        '[data-session-catalog-load-more="codex"]',
      );
      expect(retry).not.toBeNull();
      const before = request.mock.calls.length;
      request.mockResolvedValueOnce(current);
      if (previousRetry) {
        request.mockResolvedValueOnce(deep);
      }
      retry!.click();
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(request.mock.calls[before]![1]).not.toHaveProperty("cursors");
      expect(request.mock.calls.length).toBe(before + (previousRetry ? 2 : 1));
      expect(sidebar.textContent).toContain("Current authorized head");
      expect(sidebar.textContent).not.toContain("Previously authorized");
      if (previousRetry) {
        expect(sidebar.textContent).toContain("Current authorized deep");
        expect(request.mock.calls[before + 1]![1]).toMatchObject({
          cursors: { "gateway:local": "current-cursor" },
        });
      }
      request.mockResolvedValueOnce(sourceCatalogPage([]));
      await sidebar.sessionData.refreshSessionCatalogs();
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Current authorized head");
      expect(sidebar.textContent).not.toContain("Current authorized deep");
      expect(sidebar.querySelector('[data-session-catalog-load-more="codex"]')).toBeNull();
    },
  );
});

describe("pending publications do not settle a failed fresh window", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["root", "publication"])("keeps explicit retry through pending %s", async (mode) => {
    const initial = sourceCatalogPage([{ threadId: "old", name: "Old authorized row" }], "old");
    const failed = sourceCatalogPage([]);
    failed.catalogs[0]!.hosts[0]!.error = { code: "UNAVAILABLE", message: "Temporary failure" };
    const pending = sourceCatalogPage([]);
    pending.catalogs[0]!.hosts[0]!.pending = true;
    const head = sourceCatalogPage([{ threadId: "head", name: "Current head" }], "new-cursor");
    const deep = sourceCatalogPage([{ threadId: "deep", name: "Current deep" }]);
    const root = deferred<typeof pending>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(failed)
      .mockReturnValueOnce(root.promise)
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce(deep);
    const { sidebar, gateway } = await mountTab(request);
    await sidebar.sessionData.loadMoreSessionCatalog("codex");
    const refreshing = sidebar.sessionData.refreshSessionCatalogs();
    if (mode === "root") {
      root.resolve(pending);
      await refreshing;
    } else {
      gateway.publishEvent("sessions.catalog.host", {
        progressId: (request.mock.calls[2]![1] as { progressId: string }).progressId,
        agentId: "main",
        catalog: pending.catalogs[0],
      });
    }
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain("Old authorized row");
    const retry = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-load-more="codex"]',
    );
    expect(retry).not.toBeNull();
    retry!.click();
    await vi.advanceTimersByTimeAsync(0);
    root.resolve(pending);
    await refreshing;
    await settleLitElement(sidebar);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[3]![1]).not.toHaveProperty("cursors");
    expect(request.mock.calls[4]![1]).toMatchObject({ cursors: { "gateway:local": "new-cursor" } });
    expect(sidebar.textContent).toContain("Current head");
    expect(sidebar.textContent).toContain("Current deep");
    expect(sidebar.textContent).not.toContain("Old authorized row");
  });
});
describe("fresh cursor ownership", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("accepts a current cursor that equals the retired window cursor", async () => {
    const old = sourceCatalogPage([{ threadId: "old", name: "Old row" }], "retired-cursor");
    const head = sourceCatalogPage([{ threadId: "head", name: "Current head" }], "fresh-first");
    const deep = sourceCatalogPage([{ threadId: "deep", name: "Current deep" }], "retired-cursor");
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce(deep);
    const { sidebar } = await mountTab(request);
    await sidebar.sessionData.loadMoreSessionCatalog("codex");
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain("Old row");
    expect(sidebar.textContent).toContain("Current deep");
    expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error).toBeUndefined();
    expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("retired-cursor");
    expect(sidebar.querySelector('[data-session-catalog-load-more="codex"]')).not.toBeNull();
  });
});

describe("fresh provider and missing-page recovery", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["initial", "expanded", "failed-expansion"])(
    "recovers a hostless provider error after %s",
    async (phase) => {
      const initial = sourceCatalogPage([{ threadId: "old", name: "Old head" }], "old-next");
      const oldDeep = sourceCatalogPage([{ threadId: "old-deep", name: "Old deep" }]);
      const failed = sourceCatalogPage([]);
      failed.catalogs[0]!.hosts = [];
      failed.catalogs[0]!.error = {
        code: "UNAVAILABLE",
        message: "Provider temporarily unavailable",
      };
      const current = sourceCatalogPage(
        [{ threadId: "current", name: "Current head" }],
        "new-next",
      );
      const deep = sourceCatalogPage([{ threadId: "deep", name: "Current deep" }]);
      const request = createGatewayRequestMock().mockResolvedValueOnce(
        phase === "initial" ? failed : initial,
      );
      const { sidebar } = await mountTab(request);
      if (phase !== "initial") {
        if (phase === "expanded") {
          request.mockResolvedValueOnce(initial).mockResolvedValueOnce(oldDeep);
        } else {
          request.mockRejectedValueOnce(new Error("Temporary page failure"));
        }
        await sidebar.sessionData.loadMoreSessionCatalog("codex");
        request.mockResolvedValueOnce(failed);
        await sidebar.sessionData.refreshSessionCatalogs();
      }
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old head");
      expect(sidebar.textContent).not.toContain("Old deep");
      const retry = sidebar.querySelector<HTMLButtonElement>(
        '[data-session-catalog-load-more="codex"]',
      );
      expect(retry).not.toBeNull();
      const before = request.mock.calls.length;
      request.mockResolvedValueOnce(current);
      if (phase !== "initial") {
        request.mockResolvedValueOnce(deep);
      }
      retry!.click();
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(request.mock.calls[before]![1]).not.toHaveProperty("cursors");
      expect(sidebar.textContent).toContain("Current head");
      if (phase !== "initial") {
        expect(sidebar.textContent).toContain("Current deep");
      }
      expect(sidebar.textContent).not.toContain("Old head");
      expect(sidebar.textContent).not.toContain("Old deep");
    },
  );
  it.each(["host", "catalog", "deeper-host", "deeper-catalog"])(
    "retries a missing %s with current authorization",
    async (mode) => {
      const initial = sourceCatalogPage([{ threadId: "old", name: "Old row" }], "old-cursor");
      const head = sourceCatalogPage([{ threadId: "head", name: "Current head" }], "fresh-cursor");
      const deep = sourceCatalogPage([{ threadId: "deep", name: "Current deep" }]);
      const missing = sourceCatalogPage([]);
      missing.catalogs[0]!.hosts = [];
      if (mode.endsWith("catalog")) {
        missing.catalogs = [];
      }
      const request = createGatewayRequestMock().mockResolvedValueOnce(initial);
      if (mode.startsWith("deeper")) {
        request.mockResolvedValueOnce(head);
      }
      request.mockResolvedValueOnce(missing);
      const { sidebar } = await mountTab(request);
      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Old row");
      const retry = sidebar.querySelector<HTMLButtonElement>(
        '[data-session-catalog-load-more="codex"]',
      );
      expect(retry).not.toBeNull();
      const before = request.mock.calls.length;
      request.mockResolvedValueOnce(head).mockResolvedValueOnce(deep);
      retry!.click();
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(request.mock.calls[before]![1]).not.toHaveProperty("cursors");
      expect(request.mock.calls[before + 1]![1]).toMatchObject({
        cursors: { "gateway:local": "fresh-cursor" },
      });
      expect(sidebar.textContent).toContain("Current deep");
      expect(sidebar.textContent).not.toContain("Old row");
    },
  );
});

describe("completed publication resumes requested depth after a failed expansion", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("replays the failed window from the new authorized publication", async () => {
    const initial = sourceCatalogPage([{ threadId: "old", name: "Old head" }], "old-next");
    const pending = sourceCatalogPage([]);
    pending.catalogs[0]!.hosts[0]!.pending = true;
    const head = sourceCatalogPage(
      [{ threadId: "head", name: "Current published head" }],
      "new-next",
    );
    const deep = sourceCatalogPage([{ threadId: "deep", name: "Current published deep" }]);
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(deep);
    const { sidebar, gateway } = await mountTab(request);
    await sidebar.sessionData.loadMoreSessionCatalog("codex");
    await sidebar.sessionData.refreshSessionCatalogs();
    gateway.publishEvent("sessions.catalog.host", {
      progressId: (request.mock.calls[2]![1] as { progressId: string }).progressId,
      agentId: "main",
      catalog: head.catalogs[0],
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleLitElement(sidebar);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3]![1]).toMatchObject({ cursors: { "gateway:local": "new-next" } });
    expect(sidebar.textContent).toContain("Current published head");
    expect(sidebar.textContent).toContain("Current published deep");
    expect(sidebar.textContent).not.toContain("Old head");
  });
});

describe("hidden discovery is not a requested expanded window", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([true, false])("retires an exhausted empty sweep, fresh=%s", async (fresh) => {
    const page = fresh ? sourceCatalogPage : catalogPage;
    const initial = page([{ threadId: "initial", name: "Previously visible" }]);
    const empty = page([], "discovery-cursor");
    const exhausted = page([]);
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(empty);
    if (fresh) {
      request.mockResolvedValueOnce(empty);
    }
    request.mockResolvedValueOnce(exhausted);
    const { sidebar } = await mountTab(request);
    await sidebar.sessionData.refreshSessionCatalogs();
    await settleLitElement(sidebar);
    expect(request).toHaveBeenCalledTimes(fresh ? 4 : 3);
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
    expect(sidebar.sessionData.sessionCatalogLive.discoveryPages.size).toBe(0);
    expect(sidebar.textContent).not.toContain("Previously visible");
  });
});

describe("root reconciliation while a source retry owns one host", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([
    { order: "target-first", progress: "absent", outcome: "rows" },
    { order: "root-first", progress: "absent", outcome: "rows" },
    { order: "target-first", progress: "before", outcome: "rows" },
    { order: "root-first", progress: "after", outcome: "rows" },
    { order: "root-first", progress: "absent", outcome: "target-error" },
    { order: "target-first", progress: "absent", outcome: "peer-revoked" },
    { order: "target-first", progress: "absent", outcome: "root-error" },
    { order: "root-first", progress: "absent", outcome: "reset" },
    { order: "target-first", progress: "absent", outcome: "provider-error" },
    { order: "root-first", progress: "absent", outcome: "provider-error" },
  ])(
    "reconciles $order/$progress/$outcome without stale authority",
    async ({ order, progress, outcome }) => {
      const initial = sourceCatalogPage([{ threadId: "old", name: "Old target" }], "old-cursor");
      const peer = {
        ...sourceCatalogPage([{ threadId: "old-peer", name: "Old peer" }]).catalogs[0]!.hosts[0]!,
        hostId: "node:peer",
        label: "Peer source",
      };
      initial.catalogs[0]!.hosts.push(peer);
      const target = sourceCatalogPage([{ threadId: "target", name: "Target retry result" }]);
      const aggregate = sourceCatalogPage([{ threadId: "retired", name: "Retired target result" }]);
      const freshPeer = {
        ...peer,
        sessions: [{ ...peer.sessions[0]!, threadId: "fresh-peer", name: "Fresh peer" }],
      };
      if (outcome !== "peer-revoked") {
        aggregate.catalogs[0]!.hosts.push(freshPeer);
      }
      const root = deferred<typeof aggregate>();
      const retry = deferred<typeof target>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(initial)
        .mockRejectedValueOnce(new Error("Target temporarily unavailable"))
        .mockReturnValueOnce(root.promise)
        .mockReturnValueOnce(retry.promise)
        .mockResolvedValue(target);
      const { sidebar, gateway } = await mountTab(request);
      await loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
      const refreshing = sidebar.sessionData.refreshSessionCatalogs();
      await settleLitElement(sidebar);
      const button = sidebar.querySelector<HTMLButtonElement>(
        '[data-session-catalog-load-more="codex"]',
      );
      expect(button).not.toBeNull();
      button!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls[3]![1]).toMatchObject({ hostIds: ["gateway:local"] });
      expect(request.mock.calls[3]![1]).not.toHaveProperty("cursors");
      const publish = () =>
        gateway.publishEvent("sessions.catalog.host", {
          progressId: (request.mock.calls[2]![1] as { progressId: string }).progressId,
          agentId: "main",
          catalog: { ...aggregate.catalogs[0]!, hosts: [freshPeer] },
        });
      if (progress === "before") {
        publish();
      }
      if (outcome === "reset") {
        request.mockResolvedValue(sourceCatalogPage([]));
        resetSessionCatalogConnection(sidebar.sessionData);
      }
      const finishRoot = async () => {
        if (outcome === "root-error") {
          root.reject(new Error("Root temporarily unavailable"));
        } else {
          root.resolve(
            outcome === "provider-error"
              ? {
                  catalogs: [
                    {
                      ...aggregate.catalogs[0]!,
                      hosts: [],
                      error: { code: "UNAVAILABLE", message: "Discovery temporarily unavailable" },
                    },
                  ],
                }
              : aggregate,
          );
        }
        await refreshing;
      };
      const finishTarget = async () => {
        if (outcome === "target-error") {
          retry.reject(new Error("Retry temporarily unavailable"));
        } else {
          retry.resolve(target);
        }
        await vi.advanceTimersByTimeAsync(0);
      };
      if (order === "root-first") {
        await finishRoot();
        await finishTarget();
      } else {
        await finishTarget();
        await finishRoot();
      }
      if (progress === "after") {
        publish();
      }
      await settleLitElement(sidebar);
      if (outcome === "target-error") {
        const retryButton = sidebar.querySelector<HTMLButtonElement>(
          '[data-session-catalog-load-more="codex"]',
        );
        expect(retryButton).not.toBeNull();
        retryButton!.click();
        await vi.advanceTimersByTimeAsync(0);
        await settleLitElement(sidebar);
        expect(request.mock.calls.at(-1)![1]).not.toHaveProperty("cursors");
      }
      if (outcome === "provider-error") {
        expect(sidebar.sessionData.sessionCatalogs[0]?.error?.message).toBe(
          "Discovery temporarily unavailable",
        );
        expect(sidebar.textContent).toContain("Target retry result");
        expect(sidebar.textContent).not.toContain("Fresh peer");
        const retryRoot = sidebar.querySelector<HTMLButtonElement>(
          '[data-session-catalog-load-more="codex"]',
        );
        expect(retryRoot).not.toBeNull();
        const recovery = structuredClone(target);
        recovery.catalogs[0]!.hosts.push(freshPeer);
        request.mockResolvedValueOnce(recovery);
        const before = request.mock.calls.length;
        retryRoot!.click();
        await vi.advanceTimersByTimeAsync(0);
        await settleLitElement(sidebar);
        expect(request).toHaveBeenCalledTimes(before + 1);
        expect(request.mock.calls[before]![1]).not.toHaveProperty("hostIds");
        expect(request.mock.calls[before]![1]).not.toHaveProperty("cursors");
      }
      const text = sidebar.textContent ?? "";
      expect(text.includes("Old peer")).toBe(false);
      expect(text.includes("Old target")).toBe(false);
      expect(text.includes("Retired target result")).toBe(false);
      expect(text.includes("Target retry result")).toBe(outcome !== "reset");
      expect(text.includes("Fresh peer")).toBe(
        !["reset", "peer-revoked", "root-error"].includes(outcome),
      );
      if (outcome !== "reset") {
        expect(request).toHaveBeenCalledTimes(
          ["target-error", "provider-error"].includes(outcome) ? 5 : 4,
        );
      }
    },
  );
});

describe("catalog return without a progress frame", () => {
  beforeEach(() => vi.useFakeTimers(catalogClock));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["fresh", "ordinary", "adopted"] as const)(
    "reconciles a returning %s catalog after authoritative absence",
    async (mode) => {
      const page = mode === "fresh" ? sourceCatalogPage : catalogPage;
      const initial = page([{ threadId: "old", name: "Previous catalog row" }]);
      const returning = page([{ threadId: "new", name: "Returning catalog row" }]);
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({ catalogs: [] })
        .mockResolvedValueOnce(returning);
      const { sidebar } = await mountTab(request);
      if (mode === "adopted") {
        applySessionCatalogContinuation(sidebar.sessionData, {
          catalogId: "codex",
          hostId: "gateway:local",
          threadId: "old",
          agentId: "main",
          sessionKey: "agent:main:adopted",
        });
      }
      await sidebar.sessionData.refreshSessionCatalogs();
      await settleLitElement(sidebar);
      expect(sidebar.sessionData.sessionCatalogs).toEqual([]);
      expect(sidebar.textContent).not.toContain("Previous catalog row");
      await sidebar.sessionData.refreshSessionCatalogs();
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Returning catalog row");
      expect(sidebar.textContent).not.toContain("Previous catalog row");
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
});
