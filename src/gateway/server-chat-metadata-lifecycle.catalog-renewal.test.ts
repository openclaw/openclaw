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
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
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
          getPreparedOwner: getPublishedPreparedModelCatalogOwnerSnapshot,
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
    allowGatewaySubagentBinding: true,
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
    const current = getPublishedPreparedModelCatalogOwnerSnapshot({ config, agentId: "main" });
    if (!current) {
      throw new Error("Metadata publication omitted its model owner");
    }
    observedCatalogs.push(
      structuredClone(current.readFullModelCatalog?.() ?? current.modelCatalog),
    );
  });
  const lifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: () => config,
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
  return { config, inventory, broadcast, observedCatalogs, lifecycle, stop: () => sidecars.stop() };
}

describe("catalog renewal metadata broadcasts", () => {
  it("retains the published model owner across metadata reads and catalog renewal", async () => {
    const harness = await createRenewalLifecycle();
    try {
      expect(owner.isCurrent()).toBe(true);
      const next = structuredClone(harness.inventory);
      next.entries.push({ provider: "custom", id: "renewed", name: "Renewed" });
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(next);
      await owner.loadFullModelCatalog!({ refresh: true, providerIds: ["custom"] });
      const metadata = await harness.lifecycle.read({ agentId: "main" });
      expect(metadata.models?.map(({ id }) => id).toSorted()).toEqual(
        next.entries.map(({ id }) => id).toSorted(),
      );
      expect(owner.isCurrent()).toBe(true);
      expect(harness.broadcast).toHaveBeenCalledOnce();
      await harness.lifecycle.read({ agentId: "main" });
      expect(harness.broadcast).toHaveBeenCalledOnce();
      expect(owner.isCurrent()).toBe(true);
    } finally {
      await harness.stop();
    }
  });

  it("observes expired published inventory without starting provider discovery", async () => {
    const harness = await createRenewalLifecycle();
    const inventoryOwner = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!;
    inventoryOwner.catalogInventory!.providers.get("custom")!.expiresAt = 0;
    const acquisitions = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    try {
      await harness.lifecycle.refresh();
      const metadata = await harness.lifecycle.read({ agentId: "main" });
      expect(metadata.models).toMatchObject(harness.inventory.entries);
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(acquisitions);
    } finally {
      await harness.stop();
    }
  });

  it.each(["usage", "removed", "failed"] as const)(
    "publishes only settled visible changes for a renewal (%s)",
    async (change) => {
      const harness = await createRenewalLifecycle();
      const entered = createDeferred();
      const release = createDeferred();
      const settled = createDeferred();
      const original = owner.readFullModelCatalog!()!;
      const publications = vi.fn<
        Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]
      >((event) => {
        if (event.phase === "catalog-published" || event.phase === "catalog-failed") {
          settled.resolve();
        }
      });
      const unregister = registerPreparedModelRuntimePublicationListener(publications);
      const next = structuredClone(harness.inventory);
      if (change === "removed") {
        next.entries = next.entries.filter(({ id }) => id !== "second");
      }
      if (change === "usage") {
        const auth = getPreparedModelFullCatalogAuth(original)!;
        setPreparedModelFullCatalogAuth(next, {
          ...auth,
          authStore: {
            ...auth.authStore,
            lastGood: { custom: "custom:default" },
            usageStats: { "custom:default": { lastUsed: 42 } },
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
      owner.refreshExpiredModelCatalog!();
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
        // Observe the expiry renewal; an explicit refresh requests another acquisition.
        renewal = settled.promise;
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
                  modelFactsChanged: change !== "usage",
                  refreshStatusChanged: true,
                },
              ],
        );
        expect(harness.broadcast.mock.calls).toEqual([
          [
            "chat.metadata.changed",
            {
              modelCatalogChanged: true,
              authChanged: change !== "usage" && change !== "failed",
              commandsChanged: false,
            },
            { dropIfSlow: true },
          ],
        ]);
        expect(harness.observedCatalogs).toHaveLength(1);
        const observedCatalog = harness.observedCatalogs[0];
        if (!observedCatalog) {
          throw new Error("Expected the settled catalog notification");
        }
        expect(observedCatalog.pendingProviders).toBeUndefined();
        // The pending reply remains pending until the consumer receives the settlement signal.
        expect(pendingCatalog.pendingProviders).toEqual(["custom"]);
        const modelChanges = change === "usage" ? 0 : 1;
        expect(buildCommands).toHaveBeenCalledTimes(modelChanges);
        expect(buildProjection).toHaveBeenCalledTimes(modelChanges);
        if (change === "usage") {
          expect(owner.readFullModelCatalog!()).toBe(original);
          expect(observedCatalog.entries).toEqual(pendingCatalog.entries);
          expect(owner.isCurrent()).toBe(true);
          expect(getPreparedModelFullCatalogAuth(original)?.authStore.lastGood).toEqual({
            custom: "custom:default",
          });
        } else if (change === "removed") {
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
