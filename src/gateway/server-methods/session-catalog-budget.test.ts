import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishSessionCatalogHost } from "../../plugin-sdk/session-catalog-paging.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
  setSessionCatalogEntries,
  startCall,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

beforeEach(() => {
  resetSessionCatalogTestState();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("returns three fast catalogs within one second while an eight-second provider finishes later", async () => {
  const host = {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway" as const,
    connected: true,
    sessions: [],
  };
  hoisted.activeRegistry.sessionCatalogs = [
    ...["fast-a", "fast-b", "fast-c"].map((id) => ({
      provider: provider(id, { list: async () => [host] }),
    })),
    {
      provider: provider("slow", {
        list: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 8_000);
          });
          return [host];
        },
      }),
    },
  ];
  const startedAt = Date.now();
  const rootsBefore = getActiveGatewayRootWorkCount();
  const root = tryBeginGatewayRootWorkAdmission("catalog-budget-fixture");
  expect(root).not.toBeNull();
  const pending = await root!.run(async () => startCall("sessions.catalog.list", {}));
  let elapsed: number | undefined;
  void pending.completion.then(() => {
    elapsed = Date.now() - startedAt;
  });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.respond).toHaveBeenCalledWith(true, {
      catalogs: [
        ...["fast-a", "fast-b", "fast-c"].map((id) =>
          expect.objectContaining({ id, hosts: [host] }),
        ),
        expect.objectContaining({
          id: "slow",
          error: expect.objectContaining({ code: "catalog_pending" }),
        }),
      ],
    });
    expect(elapsed).toBeLessThanOrEqual(1_000);
    root!.release();
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 1);
  } finally {
    await vi.advanceTimersByTimeAsync(7_000);
    await pending.completion;
    root!.release();
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
    console.info("catalog slow-provider fixture", {
      providers: 4,
      providerDelayMs: 8_000,
      responseMs: elapsed,
    });
  }
});

it("reuses pending discovery and preserves authoritative host withdrawals in fallback pages", async () => {
  const oldHost = {
    hostId: "node:slow",
    label: "Old page",
    kind: "node" as const,
    connected: true,
    sessions: [],
  };
  const freshHost = { ...oldHost, label: "Late page" };
  const late = createDeferredCore<(typeof freshHost)[]>();
  const retry = createDeferredCore<(typeof freshHost)[]>();
  const publication = createDeferredCore<typeof freshHost>();
  const list = vi
    .fn<SessionCatalogProvider["list"]>()
    .mockResolvedValueOnce([oldHost])
    .mockImplementationOnce(() => late.promise)
    .mockRejectedValue(Object.assign(new Error("node did not respond"), { code: "TIMEOUT" }));
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
  const config = {};
  const client = { connId: "owner" };
  const query = { allowPartialResults: true, progressId: "withdrawal" };
  const context = { broadcastToConnIds: vi.fn() };
  await call("sessions.catalog.list", query, config, client, context);
  try {
    for (let index = 0; index < 3; index++) {
      const waiting = startCall("sessions.catalog.list", query, config, client, context);
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting.completion;
      expect(waiting.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [{ ...oldHost, pending: true }],
            error: expect.objectContaining({
              code: "catalog_pending",
              message: expect.stringContaining("stale"),
            }),
          }),
        ],
      });
    }
    expect(list).toHaveBeenCalledTimes(2);
    late.resolve([freshHost]);
    await vi.advanceTimersByTimeAsync(0);
    const failed = await call("sessions.catalog.list", query, config, client, context);
    expect(failed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [freshHost],
          error: expect.objectContaining({
            code: "catalog_stale",
            message: expect.stringContaining("TIMEOUT"),
          }),
        }),
      ],
    });
    const offlineHost = {
      ...freshHost,
      sessions: [],
      error: { code: "UNAVAILABLE", message: "node offline" },
    };
    const loadingHost = { ...oldHost, hostId: "node:loading", pending: true };
    const completedHost = { ...freshHost, hostId: loadingHost.hostId, label: "Completed page" };
    list.mockImplementationOnce(async (params) => {
      publishSessionCatalogHost(params, publication.promise);
      return [offlineHost, loadingHost];
    });
    const offline = await call("sessions.catalog.list", query, config, client, context);
    expect(offline).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [offlineHost, loadingHost],
        }),
      ],
    });
    list.mockImplementationOnce(() => retry.promise);
    const pending = startCall("sessions.catalog.list", query, config, client, context);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending.completion;
    expect(pending.respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [offlineHost, loadingHost],
          error: expect.objectContaining({ code: "catalog_pending" }),
        }),
      ],
    });
    publication.resolve(completedHost);
    await vi.advanceTimersByTimeAsync(0);
    retry.reject(new Error("Provider enumeration failed"));
    await vi.advanceTimersByTimeAsync(0);
    const rejected = await call("sessions.catalog.list", query, config, client, context);
    expect(rejected).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [offlineHost, completedHost],
          error: expect.objectContaining({
            code: "catalog_stale",
            message: expect.stringContaining("TIMEOUT"),
          }),
        }),
      ],
    });
  } finally {
    late.resolve([freshHost]);
    retry.resolve([]);
    publication.resolve({ ...freshHost, hostId: "node:loading" });
    await vi.advanceTimersByTimeAsync(0);
  }
});

it.each(["caller", "query", "config", "registration", "gateway", "archive"] as const)(
  "does not reuse a cached page after a change to %s",
  async (change) => {
    const host = {
      hostId: "gateway:local",
      label: "Private page",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi
      .fn<SessionCatalogProvider["list"]>()
      .mockResolvedValueOnce([host])
      .mockRejectedValue(Object.assign(new Error("unavailable"), { code: "UNAVAILABLE" }));
    const fixture = provider("fixture", { list, archive: async () => ({ ok: true }) });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: fixture }];
    let config = {};
    let client = { connId: "first" };
    let gateway = new AbortController();
    await call("sessions.catalog.list", {}, config, client, {
      requestEntryLifetime: { signal: gateway.signal },
    });
    if (change === "caller") {
      client = { connId: "second" };
    }
    if (change === "config") {
      config = {};
    }
    if (change === "registration") {
      hoisted.activeRegistry.sessionCatalogs = [{ provider: fixture }];
    }
    if (change === "gateway") {
      gateway.abort();
      gateway = new AbortController();
    }
    if (change === "archive") {
      const archived = await call(
        "sessions.catalog.archive",
        {
          catalogId: "fixture",
          hostId: host.hostId,
          threadId: "archived",
          confirmNoOtherRunner: true,
        },
        config,
        client,
      );
      expect(archived).toHaveBeenCalledWith(true, { ok: true });
    }
    const refreshed = await call(
      "sessions.catalog.list",
      change === "query" ? { search: "different" } : {},
      config,
      client,
      { requestEntryLifetime: { signal: gateway.signal } },
    );
    expect(refreshed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [],
          error: expect.objectContaining({ code: "UNAVAILABLE" }),
        }),
      ],
    });
  },
);

it("never projects a cached adoption onto a replacement session identity", async () => {
  const sessionKey = "agent:main:adopted";
  setSessionCatalogEntries([
    { sessionKey, entry: { sessionId: "original", pluginOwnerId: "fixture" } },
  ]);
  const list = vi
    .fn<SessionCatalogProvider["list"]>()
    .mockResolvedValueOnce([
      {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: "old-thread",
            sessionKey,
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: true,
          },
        ],
      },
    ])
    .mockRejectedValue(new Error("offline"));
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
  const config = {};
  const original = await call("sessions.catalog.list", {}, config);
  expect(original.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0]?.sessionKey).toBe(
    sessionKey,
  );
  setSessionCatalogEntries([
    { sessionKey, entry: { sessionId: "replacement", pluginOwnerId: "fixture" } },
  ]);
  const stale = await call("sessions.catalog.list", {}, config);
  expect(stale.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0]).toMatchObject({
    threadId: "old-thread",
  });
  expect(stale.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0]).not.toHaveProperty(
    "sessionKey",
  );
});

it.each([false, true])(
  "keeps fresh sibling adoption identities separate from stale pages (reused key=%s)",
  async (reusedKey) => {
    const keys = ["agent:main:first", reusedKey ? "agent:main:first" : "agent:main:second"];
    const setEntries = (secondId: string) =>
      setSessionCatalogEntries(
        keys.map((sessionKey, index) => ({
          sessionKey,
          entry: { sessionId: index === 0 ? "first" : secondId, pluginOwnerId: `fixture-${index}` },
        })),
      );
    const hosts = keys.map((sessionKey, index) => ({
      hostId: "gateway:local",
      label: `Provider ${index}`,
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: `thread-${index}`,
          sessionKey,
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    }));
    const late = createDeferredCore<typeof hosts>();
    const slow = vi
      .fn<SessionCatalogProvider["list"]>()
      .mockResolvedValueOnce([hosts[0]!])
      .mockImplementationOnce(() => late.promise);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("fixture-0", { list: slow }) },
      { provider: provider("fixture-1", { list: async () => [hosts[1]!] }) },
    ];
    const config = {};
    setEntries("original");
    await call("sessions.catalog.list", {}, config);
    setEntries("replacement");
    const next = startCall("sessions.catalog.list", {}, config);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await next.completion;
      expect(next.respond.mock.calls[0]?.[1]?.catalogs[1]?.hosts[0]?.sessions[0]?.sessionKey).toBe(
        keys[1],
      );
      expect(next.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0]?.sessionKey).toBe(
        reusedKey ? undefined : keys[0],
      );
    } finally {
      late.resolve([hosts[0]!]);
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);
