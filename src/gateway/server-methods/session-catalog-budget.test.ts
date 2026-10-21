import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishSessionCatalogHost } from "../../plugin-sdk/session-catalog-paging.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  catalogHost,
  catalogProvider as provider,
  catalogSession,
  expectCatalog,
  expectCatalogs,
} from "./session-catalog.fixtures.test-support.js";
import {
  call,
  hoisted,
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

const sessionRow = (respond: ReturnType<typeof startCall>["respond"], catalog = 0) =>
  respond.mock.calls[0]?.[1]?.catalogs[catalog]?.hosts[0]?.sessions[0];

it("returns three fast catalogs within one second while an eight-second provider finishes later", async () => {
  const host = catalogHost();
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
    expectCatalogs(pending.respond, [
      ...["fast-a", "fast-b", "fast-c"].map((id) => expect.objectContaining({ id, hosts: [host] })),
      expect.objectContaining({
        id: "slow",
        error: expect.objectContaining({ code: "catalog_pending" }),
      }),
    ]);
    expect(elapsed).toBeLessThanOrEqual(1_000);
    root!.release();
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 1);
  } finally {
    await vi.advanceTimersByTimeAsync(7_000);
    await pending.completion;
    root!.release();
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
  }
});

it("reuses pending discovery and preserves authoritative host withdrawals in fallback pages", async () => {
  const oldHost = catalogHost({ hostId: "node:slow", label: "Old page", kind: "node" });
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
      await vi.advanceTimersByTimeAsync(0);
      expectCatalog(waiting.respond, {
        hosts: [{ ...oldHost, pending: true }],
        error: expect.objectContaining({
          code: "catalog_pending",
          message: expect.stringContaining("stale"),
        }),
      });
      await waiting.completion;
    }
    expect(list).toHaveBeenCalledTimes(2);
    late.resolve([freshHost]);
    await vi.advanceTimersByTimeAsync(0);
    const failed = await call("sessions.catalog.list", query, config, client, context);
    expectCatalog(failed, {
      hosts: [freshHost],
      error: expect.objectContaining({
        code: "catalog_stale",
        message: expect.stringContaining("TIMEOUT"),
      }),
    });
    const offlineHost = {
      ...freshHost,
      error: { code: "UNAVAILABLE", message: "node offline" },
    };
    const loadingHost = { ...oldHost, hostId: "node:loading", pending: true };
    const completedHost = { ...freshHost, hostId: loadingHost.hostId, label: "Completed page" };
    list.mockImplementationOnce(async (params) => {
      publishSessionCatalogHost(params, publication.promise);
      return [offlineHost, loadingHost];
    });
    const offline = await call("sessions.catalog.list", query, config, client, context);
    expectCatalog(offline, {
      hosts: [offlineHost, loadingHost],
    });
    list.mockImplementationOnce(() => retry.promise);
    const pending = startCall("sessions.catalog.list", query, config, client, context);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending.completion;
    expectCatalog(pending.respond, {
      hosts: [offlineHost, loadingHost],
      error: expect.objectContaining({ code: "catalog_pending" }),
    });
    publication.resolve(completedHost);
    await vi.advanceTimersByTimeAsync(0);
    retry.reject(new Error("Provider enumeration failed"));
    await vi.advanceTimersByTimeAsync(0);
    const rejected = await call("sessions.catalog.list", query, config, client, context);
    expectCatalog(rejected, {
      hosts: [offlineHost, completedHost],
      error: expect.objectContaining({
        code: "catalog_stale",
        message: expect.stringContaining("TIMEOUT"),
      }),
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
    const host = catalogHost({ label: "Private page" });
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
    expectCatalog(refreshed, {
      hosts: [],
      error: expect.objectContaining({ code: "UNAVAILABLE" }),
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
      catalogHost({
        sessions: [catalogSession("old-thread", { sessionKey, canArchive: true })],
      }),
    ])
    .mockRejectedValue(new Error("offline"));
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
  const config = {};
  const original = await call("sessions.catalog.list", {}, config);
  expect(sessionRow(original)?.sessionKey).toBe(sessionKey);
  setSessionCatalogEntries([
    { sessionKey, entry: { sessionId: "replacement", pluginOwnerId: "fixture" } },
  ]);
  const stale = await call("sessions.catalog.list", {}, config);
  expect(sessionRow(stale)).toMatchObject({
    threadId: "old-thread",
  });
  expect(sessionRow(stale)).not.toHaveProperty("sessionKey");
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
    const hosts = keys.map((sessionKey, index) =>
      catalogHost({
        label: `Provider ${index}`,
        sessions: [catalogSession(`thread-${index}`, { sessionKey, canArchive: true })],
      }),
    );
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
      expect(sessionRow(next.respond, 1)?.sessionKey).toBe(keys[1]);
      expect(sessionRow(next.respond)?.sessionKey).toBe(reusedKey ? undefined : keys[0]);
    } finally {
      late.resolve([hosts[0]!]);
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);
