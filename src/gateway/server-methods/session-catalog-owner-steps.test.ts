import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  hoisted,
  createSessionCatalogTestContext,
  markPluginRegistryActive,
  provider,
  resetSessionCatalogTestState,
  sessionCatalogHandlers,
  type PluginRegistry,
} from "./session-catalog.test-helpers.js";

const { listSessionCatalogProvider } = await import("./session-catalog-provider-access.js");

describe("catalog list step owner", () => {
  beforeEach(resetSessionCatalogTestState);

  it.each(["gateway context", "catalog source", "registry epoch", "disconnect"] as const)(
    "preserves the list owner boundary across %s before resuming source work",
    async (change) => {
      const blockers = createDeferredCore<SessionCatalogHost[]>();
      const first = createDeferredCore<{ done: false }>();
      const healthyStarted = createDeferredCore();
      const healthyGate = createDeferredCore<SessionCatalogHost[]>();
      const entryOwner = new AbortController();
      const connection = new AbortController();
      const instance = new PluginInstance("source");
      const sourceRead = vi.fn();
      const close = vi.fn();
      let sourceSignal: AbortSignal | undefined;
      let currentContext = true;
      const config = {};
      const context: Record<string, unknown> = createSessionCatalogTestContext(config, {
        requestEntryLifetime: { signal: entryOwner.signal },
        broadcastToConnIds: vi.fn(),
      });
      context.resolveGatewayContext = () => (currentContext ? context : undefined);
      const catalog = instance.wrap(
        provider("source", {
          audience: "session-viewers",
          createListOperation: (params) => {
            sourceSignal = params.signal;
            return {
              async next() {
                sourceRead();
                return sourceRead.mock.calls.length === 1
                  ? await first.promise
                  : { done: true, hosts: [] };
              },
              close,
            };
          },
        }),
      );
      hoisted.activeRegistry.sessionCatalogs = [{ provider: catalog }];
      const active = Array.from({ length: 15 }, (_, index) =>
        listSessionCatalogProvider(
          provider(`blocking-${index}`, { list: () => blockers.promise }),
          {},
        ),
      );
      const respond = vi.fn();
      const pending = Promise.resolve(
        sessionCatalogHandlers["sessions.catalog.list"]!({
          params: { catalogId: "source", progressId: "owner-proof" },
          client: { connId: "fixture", connectionSignal: connection.signal },
          context,
          respond,
        } as never),
      );
      const healthy = listSessionCatalogProvider(
        provider("healthy", {
          list: () => {
            healthyStarted.resolve();
            return healthyGate.promise;
          },
        }),
        {},
      );
      try {
        first.resolve({ done: false });
        await healthyStarted.promise;
        expect(sourceRead.mock.calls, JSON.stringify(respond.mock.calls)).toHaveLength(1);
        expect(sourceSignal?.aborted).toBe(false);
        expect(instance.acceptingCalls).toBe(true);
        if (change === "gateway context") {
          currentContext = false;
        } else if (change === "catalog source") {
          hoisted.activeRegistry.sessionCatalogs = [...hoisted.activeRegistry.sessionCatalogs];
        } else if (change === "registry epoch") {
          markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
        } else {
          connection.abort();
        }
        expect(entryOwner.signal.aborted).toBe(false);
        expect(sourceSignal?.aborted).toBe(change === "registry epoch");
        expect(instance.acceptingCalls).toBe(true);
        healthyGate.resolve([]);
        await pending;
        expect(sourceRead).toHaveBeenCalledTimes(change === "disconnect" ? 2 : 1);
        expect(close).toHaveBeenCalledOnce();
        const result = respond.mock.calls[0]?.[1].catalogs[0];
        expect(result.hosts).toEqual([]);
        if (change === "disconnect") {
          expect(result.error).toBeUndefined();
        } else {
          expect(result.error).toMatchObject({ message: expect.any(String) });
        }
      } finally {
        first.resolve({ done: false });
        blockers.resolve([]);
        healthyGate.resolve([]);
        await Promise.allSettled([...active, pending, healthy]);
        await instance.dispose();
      }
    },
  );
});
