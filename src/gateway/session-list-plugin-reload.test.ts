import { expect, it } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { setRuntimeConfigSnapshot, resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

it.each(["publish", "abort", "dispose"] as const)(
  "prepares session-list policy through a replaced plugin until %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} }, defaults: { model: "openai/reasoner" } } };
      setRuntimeConfigSnapshot(cfg);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:reload-quiesce" },
        { sessionId: "reload-quiesce", updatedAt: 1, visibility: "shared" },
      );
      const instances: PluginInstance[] = [];
      const view = (defaultLevel: "low" | "high") => {
        const registry = createEmptyPluginRegistry(),
          record = createPluginRecord({ id: "openai" });
        registry.plugins.push(record);
        const instance = new PluginInstance("openai", { record, registry });
        instance.sourceDigest = "identical-plugin-code";
        instances.push(instance);
        registry.providers.push({
          pluginId: "openai",
          source: "/synthetic/openai.js",
          provider: instance.wrap({
            id: "openai",
            label: "OpenAI fixture",
            auth: [],
            resolveThinkingProfile: () => ({
              levels: [{ id: "off" as const }, { id: defaultLevel }],
              defaultLevel,
            }),
          }),
        });
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [{ id: "openai", origin: "bundled", providers: ["openai"] }],
        });
        const entries = [{ provider: "openai", id: "reasoner", name: "Reasoner", reasoning: true }];
        const prepared: ModelCatalogSnapshot = { entries, routeVariants: entries };
        prepareModelCatalogThinkingPolicies({
          catalog: prepared,
          metadataSnapshot,
          pluginRegistry: registry,
        });
        return {
          registry,
          instance,
          catalog: new Map([
            [
              "main",
              createPreparedGatewayModelCatalog({
                config: cfg,
                entries: prepared.entries,
                routeVariants: prepared.routeVariants,
                pluginRegistry: registry,
                metadataSnapshot,
              }),
            ],
          ]),
        };
      };
      const original = view("low"),
        replacement = view("high"),
        gateway = createPluginRegistryOwner(original.registry);
      markPluginRegistryActive(original.registry);
      const previousActive = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(original.registry);
      let catalog = original.catalog;
      let releaseReplacement!: () => void;
      const replacing = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      using foreground = holdForeground();
      using projection = await createTestProjection({
        cfg,
        getConfig: () => cfg,
        getModelCatalog: async () => catalog,
      });
      const request = new AsyncWorkScope();
      const list = () =>
        listProjectedSessions({
          projection,
          opts: { agentId: "main", includeGlobal: true, includeUnknown: true, archived: "all" },
        });
      try {
        const initial = await list();
        notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: replacing });
        setActivePluginRegistry(replacement.registry);
        gateway.publish(replacement.registry);
        let settled = false;
        const pending = request
          .track(list)
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        await yieldSessionListWork();
        await yieldSessionListWork();
        const settledBeforeReplacement = settled;
        if (outcome !== "publish") {
          if (outcome === "abort") {
            request.beginClose(new Error("request closed"));
          } else {
            projection.dispose();
          }
          const refused = await pending;
          expect(settledBeforeReplacement).toBe(false);
          expect(refused).toHaveProperty("error.name", "AbortError");
          return;
        }
        catalog = replacement.catalog;
        releaseReplacement();
        await replacing;
        notifyPreparedModelRuntimePublication({ phase: "published" });
        const resumed = await pending;
        expect(resumed).not.toHaveProperty("error");
        expect(settledBeforeReplacement).toBe(false);
        if ("error" in resumed) {
          throw resumed.error;
        }
        expect(resumed.value.defaults.thinkingDefault).toBe("high");
        await projection.ensureMaterialized();
        const after = await list();
        expect(initial.sessions).toHaveLength(1);
        expect(after.sessions).toHaveLength(1);
        expect(after.defaults.thinkingDefault).toBe("high");
      } finally {
        releaseReplacement();
        projection.dispose();
        foreground();
        resetConfigRuntimeState();
        request.beginClose();
        await request.drain();
        await gateway.close();
        await Promise.all(instances.map((instance) => instance.dispose()));
        restoreActivePluginRegistrySnapshot(previousActive);
      }
    });
  },
);
