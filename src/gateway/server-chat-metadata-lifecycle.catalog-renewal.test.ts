// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
} from "../agents/prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../agents/prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { ChatMetadataRuntimeDeps } from "./server-methods/chat-metadata-facts.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

const mocks = getPreparedModelRuntimeMocks();
const buildCommands = vi.fn(async () => ({ commands: [] }));
const buildProjection = vi.fn<ChatMetadataRuntimeDeps["buildProjection"]>(async ({ facts }) => ({
  modelCatalog: facts.modelCatalog.entries,
  read: () => ({ models: facts.modelCatalog.entries }),
  isCurrent: () => true,
}));
let owner: PreparedModelRuntimeSnapshot;
let state: OpenClawTestState;

vi.mock("./server-methods/chat-metadata-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/chat-metadata-runtime.js")>();
  return {
    ...actual,
    createGatewayChatMetadataRuntime: (
      params: Parameters<typeof actual.createGatewayChatMetadataRuntime>[0],
    ) =>
      actual.createGatewayChatMetadataRuntime({
        ...params,
        deps: {
          getPreparedOwner: () => owner,
          getSkillsVersion: () => 0,
          getPluginRegistryVersion: () => 0,
          buildCommands,
          buildProjection,
        },
      }),
  };
});

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "catalog-renewal-metadata" });
  await resetPreparedModelRuntimeHarness(state);
  buildCommands.mockClear();
  buildProjection.mockClear();
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function createRenewalLifecycle() {
  const config: OpenClawConfig = { agents: { entries: { main: {} } } };
  mocks.configuredAgentIds = ["main"];
  mocks.authStorage.getAll.mockReturnValue({
    custom: { type: "api_key", key: "synthetic-custom-key" },
    sibling: { type: "api_key", key: "synthetic-sibling-key" },
  });
  const inventory: ModelCatalogSnapshot = {
    entries: [
      { provider: "custom", id: "first", name: "First" },
      { provider: "custom", id: "second", name: "Second" },
      { provider: "sibling", id: "other", name: "Other" },
    ],
    routeVariants: [],
    providerOutcomes: [
      { provider: "custom", status: "ready" },
      { provider: "sibling", status: "ready" },
    ],
  };
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => structuredClone(inventory));
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  owner = getPreparedModelRuntimeSnapshot({
    config,
    agentId: "main",
    agentDir: state.agentDir("main"),
  })!;
  await owner.loadFullModelCatalog!({ refresh: true });
  const observedCatalogs: ModelCatalogSnapshot[] = [];
  const broadcast = vi.fn(() => {
    // A connected consumer receives serialized status, not the owner's live status getters.
    observedCatalogs.push(structuredClone(owner.readFullModelCatalog!()!));
  });
  const lifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: () => config,
    minimalTestGateway: false,
    log: { warn: mocks.warn } as never,
  });
  const sidecars = createGatewaySidecarStopOwner();
  await lifecycle.attachContext(
    { broadcast } as unknown as GatewayRequestContext,
    sidecars.publish,
  );
  await lifecycle.read({ agentId: "main" });
  broadcast.mockClear();
  observedCatalogs.length = 0;
  buildCommands.mockClear();
  buildProjection.mockClear();
  return { inventory, broadcast, observedCatalogs, lifecycle, stop: () => sidecars.stop() };
}

describe("catalog renewal metadata broadcasts", () => {
  it.each(["identical", "usage", "auth", "added", "removed", "outcome", "failed"] as const)(
    "publishes only settled visible changes for a renewal (%s)",
    async (change) => {
      const harness = await createRenewalLifecycle();
      const entered = createDeferred();
      const release = createDeferred();
      const original = owner.readFullModelCatalog!()!;
      const publications =
        vi.fn<Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]>();
      const unregister = registerPreparedModelRuntimePublicationListener(publications);
      const next = structuredClone(harness.inventory);
      if (change === "added") {
        next.entries.push({ provider: "custom", id: "new", name: "New" });
      } else if (change === "removed") {
        next.entries = next.entries.filter(({ id }) => id !== "second");
      } else if (change === "outcome") {
        next.providerOutcomes = [{ provider: "custom", status: "unavailable" }];
      }
      if (change === "usage" || change === "auth") {
        const auth = getPreparedModelFullCatalogAuth(original)!;
        setPreparedModelFullCatalogAuth(next, {
          ...auth,
          authStore: {
            ...auth.authStore,
            ...(change === "usage"
              ? {
                  lastGood: { custom: "custom:default" },
                  usageStats: { "custom:default": { lastUsed: 42 } },
                }
              : {
                  profiles: {
                    ...auth.authStore.profiles,
                    "custom:added": {
                      type: "api_key",
                      provider: "custom",
                      key: "synthetic-added-key",
                    },
                  },
                }),
          },
        });
      }
      mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (change === "failed") {
          throw new Error("synthetic renewal failure");
        }
        return next;
      });
      const inventoryOwner = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!;
      inventoryOwner.catalogInventory!.providers.get("custom")!.expiresAt = 0;
      owner.readFullModelCatalog!();
      let renewal: Promise<unknown> | undefined;
      try {
        await entered.promise;
        const pendingCatalog = structuredClone(original);
        expect(pendingCatalog.pendingProviders).toEqual(["custom"]);
        // An unrelated refresh during discovery must not turn progress into a metadata change.
        await harness.lifecycle.refresh();
        await harness.lifecycle.read({ agentId: "main" });
        expect.soft(harness.broadcast.mock.calls.length).toBe(0);
        expect.soft(buildCommands.mock.calls.length).toBe(0);
        expect.soft(buildProjection.mock.calls.length).toBe(0);
        renewal = owner.loadFullModelCatalog!({ refresh: true, providerIds: ["custom"] }).catch(
          (error: unknown) => error,
        );
        release.resolve();
        await renewal;
        await nextEventLoopTurn();
        const result = await harness.lifecycle.read({ agentId: "main" });
        expect(
          publications.mock.calls
            .map(([event]) => event)
            .filter((event) => event.phase === "catalog-published"),
        ).toEqual(
          change === "failed"
            ? []
            : [
                {
                  phase: "catalog-published",
                  modelFactsChanged: change !== "identical" && change !== "usage",
                  refreshStatusChanged: true,
                },
              ],
        );
        expect(harness.broadcast.mock.calls).toEqual([
          ["chat.metadata.changed", {}, { dropIfSlow: true }],
        ]);
        expect(harness.observedCatalogs).toHaveLength(1);
        const observedCatalog = harness.observedCatalogs[0];
        if (!observedCatalog) {
          throw new Error("Expected the settled catalog notification");
        }
        expect(observedCatalog.pendingProviders).toBeUndefined();
        // The pending reply remains pending until the consumer receives the settlement signal.
        expect(pendingCatalog.pendingProviders).toEqual(["custom"]);
        const modelChanges = change === "identical" || change === "usage" ? 0 : 1;
        expect(buildCommands).toHaveBeenCalledTimes(modelChanges);
        expect(buildProjection).toHaveBeenCalledTimes(modelChanges);
        if (change === "identical" || change === "usage") {
          expect(owner.readFullModelCatalog!()).toBe(original);
          expect(observedCatalog.entries).toEqual(pendingCatalog.entries);
          expect(owner.isCurrent()).toBe(true);
          if (change === "usage") {
            expect(getPreparedModelFullCatalogAuth(original)?.authStore.lastGood).toEqual({
              custom: "custom:default",
            });
          }
        } else if (change === "auth") {
          expect(
            getPreparedModelFullCatalogAuth(owner.readFullModelCatalog!()!)?.authStore.profiles,
          ).toHaveProperty("custom:added");
        } else if (change === "added" || change === "removed") {
          expect(result.models?.map(({ id }) => id).toSorted()).toEqual(
            next.entries.map(({ id }) => id).toSorted(),
          );
        } else {
          expect(owner.readFullModelCatalog!()?.refreshFailed).toBe(true);
          await owner.loadFullModelCatalog!({ refresh: true, providerIds: ["custom"] });
          await nextEventLoopTurn();
          await harness.lifecycle.read({ agentId: "main" });
          expect(owner.readFullModelCatalog!()?.refreshFailed).toBeUndefined();
          expect(harness.broadcast).toHaveBeenCalledTimes(2);
          expect(buildCommands).toHaveBeenCalledTimes(2);
          if (change === "failed") {
            expect(publications).toHaveBeenLastCalledWith({
              phase: "catalog-published",
              modelFactsChanged: false,
              refreshStatusChanged: true,
            });
          }
        }
        const broadcasts = harness.broadcast.mock.calls.length;
        await harness.lifecycle.refresh();
        await harness.lifecycle.read({ agentId: "main" });
        expect(harness.broadcast).toHaveBeenCalledTimes(broadcasts);
      } finally {
        release.resolve();
        await renewal;
        unregister();
        await harness.stop();
      }
    },
  );
});
