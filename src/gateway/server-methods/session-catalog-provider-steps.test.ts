import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
    const active = Array.from({ length: 16 }, (_, index) =>
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
