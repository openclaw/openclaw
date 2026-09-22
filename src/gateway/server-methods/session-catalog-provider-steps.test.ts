import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { publishSessionCatalogHost } from "../../plugin-sdk/session-catalog-paging.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkHolders,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";

function provider(overrides: Partial<SessionCatalogProvider> = {}): SessionCatalogProvider {
  return {
    id: "fixture",
    label: "Fixture",
    list: vi.fn(async () => []),
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    ...overrides,
  };
}

describe("session catalog provider steps", () => {
  it("constructs a source only after initial admission and never for a retired queued request", async () => {
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker = provider({ list: () => gate.promise });
    const active = Array.from({ length: 4 }, (_, index) =>
      listSessionCatalogProvider({ ...blocker, id: `blocking-${index}` }, {}),
    );
    const next = vi.fn(async () => ({ done: true as const, hosts: [] }));
    const close = vi.fn();
    const createListOperation = vi.fn<NonNullable<SessionCatalogProvider["createListOperation"]>>(
      function (this: SessionCatalogProvider, params) {
        expect(this.id).toBe("queued");
        expect(params.agentId).toBe("research");
        return { next, close };
      },
    );
    const catalog = provider({ id: "queued", createListOperation });
    const owner = new AbortController();
    const retired = listSessionCatalogProvider(catalog, { signal: owner.signal });
    const rejected = expect(retired).rejects.toThrow("retired before admission");
    const live = listSessionCatalogProvider(catalog, { agentId: "research" });
    try {
      expect(createListOperation).not.toHaveBeenCalled();
      owner.abort(new Error("retired before admission"));
      await rejected;
      expect(close).not.toHaveBeenCalled();
      gate.resolve([]);
      await expect(live).resolves.toEqual([]);
      expect(createListOperation).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(catalog.list).not.toHaveBeenCalled();
    } finally {
      gate.resolve([]);
      await Promise.allSettled([...active, retired, live]);
    }
  });

  it("hands off after a settled step while keeping one publication registration lifetime", async () => {
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const active = Array.from({ length: 3 }, (_, index) =>
      listSessionCatalogProvider(
        provider({ id: `blocking-${index}`, list: () => gate.promise }),
        {},
      ),
    );
    const step = createDeferredCore<{ done: false }>();
    const publication = createDeferredCore<SessionCatalogHost>();
    const host: SessionCatalogHost = {
      hostId: "local",
      label: "Local",
      kind: "gateway",
      connected: true,
      sessions: [],
    };
    const order: string[] = [];
    const onHost = vi.fn();
    const lifetime = new SessionCatalogListLifetime(() => true, [], ["fixture"]);
    const catalog = provider({
      createListOperation: (params) => {
        let first = true;
        return {
          async next() {
            if (first) {
              first = false;
              order.push("first");
              return await step.promise;
            }
            order.push("last");
            publishSessionCatalogHost(params, publication.promise);
            return { done: true, hosts: [host] };
          },
          close() {
            order.push("close");
          },
        };
      },
    });
    const pending = lifetime.runProvider(onHost, (params) =>
      listSessionCatalogProvider(catalog, params),
    );
    const healthy = listSessionCatalogProvider(
      provider({
        id: "healthy",
        list: async () => {
          order.push("healthy");
          return [];
        },
      }),
      {},
    );
    try {
      step.resolve({ done: false });
      await expect(pending).resolves.toEqual([host]);
      expect(order).toEqual(["first", "healthy", "last", "close"]);
      expect(onHost).not.toHaveBeenCalled();
      publication.resolve(host);
      await nextTurn();
      expect(onHost).toHaveBeenCalledWith(host);
      expect(catalog.list).not.toHaveBeenCalled();
    } finally {
      gate.resolve([]);
      step.resolve({ done: false });
      publication.resolve(host);
      await Promise.allSettled([...active, pending, healthy]);
      lifetime.finishListing();
    }
  });

  it("closes a retired queued continuation and settles its paused host publication", async () => {
    const before = getActiveGatewayRootWorkHolders();
    const root = tryBeginGatewayRootWorkAdmission("catalog-step-publication")!;
    const blocker = createDeferredCore<SessionCatalogHost[]>();
    const active = Array.from({ length: 3 }, (_, index) =>
      listSessionCatalogProvider(
        provider({ id: `blocking-${index}`, list: () => blocker.promise }),
        {},
      ),
    );
    const first = createDeferredCore<{ done: false }>();
    let host: ReturnType<typeof createDeferredCore<SessionCatalogHost>> | undefined;
    const next = vi.fn(() => first.promise);
    const close = vi.fn(() => host?.reject(new Error("list operation closed")));
    const owner = new AbortController();
    const lifetime = new SessionCatalogListLifetime(() => true, [owner.signal], ["fixture"]);
    const catalog = provider({
      createListOperation: (params) => {
        return {
          next() {
            host = createDeferredCore<SessionCatalogHost>();
            publishSessionCatalogHost(params, host.promise);
            return next();
          },
          close,
        };
      },
    });
    const pending = root.run(() =>
      lifetime.runProvider(undefined, (params) => listSessionCatalogProvider(catalog, params)),
    );
    const outcome = pending.catch((error: unknown) => error);
    const retirement = new Error("queued owner retired");
    const healthyStarted = createDeferredCore();
    const healthy = listSessionCatalogProvider(
      provider({
        id: "healthy",
        list: () => {
          healthyStarted.resolve();
          return blocker.promise;
        },
      }),
      {},
    );
    try {
      first.resolve({ done: false });
      await healthyStarted.promise;
      owner.abort(retirement);
      expect(await outcome).toBe(retirement);
      lifetime.finishListing();
      root.release();
      await nextTurn();
      expect(next).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkHolders()).toEqual(before);
    } finally {
      blocker.resolve([]);
      first.resolve({ done: false });
      host?.reject(new Error("test cleanup"));
      await Promise.allSettled([...active, pending, healthy]);
      lifetime.finishListing();
      root.release();
    }
  });

  it("joins an active step before closing after cancellation", async () => {
    const step = createDeferredCore<{ done: true; hosts: SessionCatalogHost[] }>();
    const close = vi.fn();
    const next = vi.fn(() => step.promise);
    const owner = new AbortController();
    const pending = listSessionCatalogProvider(
      provider({ createListOperation: () => ({ next, close }) }),
      { signal: owner.signal },
    );
    const outcome = pending.catch((error: unknown) => error);
    const retirement = new Error("active owner retired");
    try {
      owner.abort(retirement);
      await nextTurn();
      expect(close).not.toHaveBeenCalled();
      step.resolve({ done: true, hosts: [] });
      expect(await outcome).toBe(retirement);
      expect(next).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      step.resolve({ done: true, hosts: [] });
      await pending.catch(() => {});
    }
  });

  it.each(["factory", "step"] as const)(
    "propagates a %s failure without legacy fallback",
    async (failure) => {
      const error = new Error("source failed");
      const close = vi.fn();
      const catalog = provider({
        createListOperation: () => {
          if (failure === "factory") {
            throw error;
          }
          return {
            next: async () => {
              throw error;
            },
            close,
          };
        },
      });
      await expect(listSessionCatalogProvider(catalog, {})).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(failure === "factory" ? 0 : 1);
      expect(catalog.list).not.toHaveBeenCalled();
    },
  );
});
