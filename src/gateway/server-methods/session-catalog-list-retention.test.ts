import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  hoisted,
  provider,
  resetSessionCatalogTestState,
  startCall,
} from "./session-catalog.test-helpers.js";
import type { GatewayClient } from "./types.js";

const { getSessionCatalogListOperations } = await import("./session-catalog-list-operations.js");
const { catalogRegistrationSnapshot } = await import("./session-catalog-provider-access.js");

beforeEach(() => {
  resetSessionCatalogTestState();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it.each(["completion", "list"] as const)(
  "releases catalog state across 1,000 reconnects with a hung %s",
  async (mode) => {
    const release = createDeferredCore();
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list: async ({ waitUntil }) => {
            if (mode === "completion") {
              waitUntil?.(release.promise);
            } else {
              await release.promise;
            }
            return [];
          },
        }),
      },
    ];
    const config = { agents: { list: [{ id: "main" }] } };
    const gateway = new AbortController();
    const drain = getGatewayRestartDrainSignal();
    const before = getEventListeners(drain, "abort").length;
    let retainedProviders = 0;
    let retainedPages = 0;
    try {
      for (let index = 0; index < 1_000; index++) {
        const connection = new AbortController();
        const client = { connId: `reconnect-${index}`, connectionSignal: connection.signal };
        const pending = startCall("sessions.catalog.list", {}, config, client, {
          requestEntryLifetime: { signal: gateway.signal },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await pending.completion;
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "fixture" })],
        });
        connection.abort();
        const operations = getSessionCatalogListOperations(
          config,
          catalogRegistrationSnapshot(),
          gateway.signal,
          client as GatewayClient,
        );
        retainedProviders = Math.max(retainedProviders, operations.providers.size);
        retainedPages = Math.max(retainedPages, operations.pages.size);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      const counts = {
        reconnects: 1_000,
        drainListeners: getEventListeners(drain, "abort").length - before,
        gatewayListeners: getEventListeners(gateway.signal, "abort").length,
        retainedProviders,
        retainedPages,
      };
      console.info("catalog reconnect retention", mode, counts);
      expect(counts).toEqual({
        reconnects: 1_000,
        drainListeners: 0,
        gatewayListeners: 0,
        retainedProviders: 0,
        retainedPages: 0,
      });
    } finally {
      gateway.abort();
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);

it("expires delivery without releasing native work that ignores cancellation", async () => {
  const { SessionCatalogListLifetime } = await import("./session-catalog-list-lifetime.js");
  const { GatewayConnectionWork } = await import("../server-connection-work.js");
  const { getActiveGatewayRootWorkCount, tryBeginGatewayRootWorkAdmission } =
    await import("../../process/gateway-work-admission.js");
  const before = getActiveGatewayRootWorkCount();
  const root = tryBeginGatewayRootWorkAdmission("catalog-delivery-deadline");
  const owner = new GatewayConnectionWork();
  const lifetime = new SessionCatalogListLifetime(() => true, [], ["fixture"]);
  const release = createDeferredCore();
  let signal: AbortSignal | undefined;
  try {
    await owner.track(() =>
      root!.run(() =>
        lifetime.runProvider(undefined, async (params) => {
          signal = params.signal;
          params.waitUntil(release.promise);
        }),
      ),
    );
    root!.release();
    lifetime.finishListing();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
    expect(owner.hasPendingWork).toBe(true);
    release.resolve();
    await owner.drain();
    expect(getActiveGatewayRootWorkCount()).toBe(before);
  } finally {
    release.resolve();
    lifetime.retire();
    lifetime.finishListing();
    root!.release();
    await owner.drain();
  }
});

it("caps pending provider keys and refuses late pages from evicted operations", async () => {
  const { SessionCatalogListLifetime } = await import("./session-catalog-list-lifetime.js");
  const { listSessionCatalogWithinBudget } = await import("./session-catalog-list-operations.js");
  const operations = getSessionCatalogListOperations({}, catalogRegistrationSnapshot());
  const catalog = {
    id: "fixture",
    label: "Fixture",
    hosts: [],
    capabilities: { continueSession: false, archive: false },
  };
  const page = { catalogs: [catalog], instancesByCatalog: new Map([[catalog.id, new Map()]]) };
  const releases = Array.from({ length: 129 }, () => createDeferredCore<typeof page>());
  const lifetimes = releases.map(
    () => new SessionCatalogListLifetime(() => true, [], [catalog.id]),
  );
  const lists = releases.map((release, index) =>
    listSessionCatalogWithinBudget(
      operations,
      `query-${index}`,
      lifetimes[index]!,
      () => undefined,
      catalog,
      () => release.promise,
    ),
  );
  try {
    expect(operations.providers.size).toBe(128);
    releases[0]!.resolve(page);
    releases[1]!.resolve(page);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(lists);
    expect(operations.pages.has("query-0")).toBe(false);
    expect(operations.pages.get("query-1")).toEqual(page);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(operations.providers.size).toBe(0);
    releases[2]!.resolve(page);
    await releases[2]!.promise;
    expect(operations.pages.has("query-2")).toBe(false);
  } finally {
    for (const release of releases) {
      release.resolve(page);
    }
    for (const lifetime of lifetimes) {
      lifetime.finishListing();
    }
    await Promise.all(lists);
  }
});
