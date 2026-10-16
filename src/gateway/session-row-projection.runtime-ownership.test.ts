import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentHarnessPreflightError } from "../agents/harness/errors.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginPluginStatePublication } from "../plugin-state/plugin-state-publication.js";
import { createPluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("rereads native model ownership after its harness plugin config changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:config";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "config-bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "present");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "native-config",
        updatedAt: 1,
        agentHarnessId: "row-native",
        modelSelectionLocked: true,
      },
    );
    const config = (model: string): OpenClawConfig => ({
      agents: { entries: { main: {} }, defaults: { model: "example/fallback" } },
      plugins: { entries: { "row-native": { enabled: true, config: { model } } } },
    });
    let cfg = config("original-native");
    setRuntimeConfigSnapshot(cfg);
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "row-native",
      source: "test",
      harness: {
        id: "row-native",
        label: "Native config fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Presentation must not run a model");
        },
        resolveSessionRuntimeOwnershipAsync: async (params) => {
          await bindings.lookup(params.sessionKey!);
          return {
            model: "native",
            auth: "native",
            modelRef: {
              provider: "example",
              model: String(cfg.plugins!.entries!["row-native"]!.config!.model),
            },
          };
        },
      },
    });
    setActivePluginRegistry(registry);
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "row-native", activation: { onAgentHarnesses: ["row-native"] } }],
    });
    const view = () =>
      new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({
            config: cfg,
            entries: [{ provider: "example", id: "fallback", name: "Fallback" }],
            pluginRegistry: registry,
            metadataSnapshot,
          }),
        ],
      ]);
    let catalog = view();
    const release = retainSessionListForegroundWork();
    let projection: SessionRowProjection | undefined;
    try {
      projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        getModelCatalog: async () => catalog,
      });
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]?.model).toBe(
        "original-native",
      );
      cfg = config("replacement-native");
      setRuntimeConfigSnapshot(cfg);
      catalog = view();
      notifyPreparedModelRuntimePublication({ phase: "published" });
      await projection.ensureMaterialized();
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]?.model).toBe(
        "replacement-native",
      );
    } finally {
      projection?.dispose();
      release();
      restoreActivePluginRegistrySnapshot(previousRegistry);
      resetConfigRuntimeState();
    }
  });
});

it.for(["once", "continued", "failure"] as const)(
  "keeps native ownership changes local to one listed row: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: {
          entries: { main: {} },
          defaults: { model: { primary: "openai/gpt-5.5" } },
        },
      };
      const key = "agent:main:harness:row-native:changing";
      for (const sessionKey of [key, "agent:main:dashboard:unaffected"]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey === key ? "changing" : "unaffected",
            updatedAt: sessionKey === key ? 2 : 1,
            ...(sessionKey === key
              ? { agentHarnessId: "row-native", modelSelectionLocked: true }
              : {}),
          },
        );
      }
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const registry = createEmptyPluginRegistry();
      const failure = new AgentHarnessPreflightError("Synthetic native read failure");
      let changed = false;
      let reads = 0;
      let changing = false;
      registry.agentHarnesses.push({
        pluginId: "row-native",
        source: "test",
        harness: {
          id: "row-native",
          label: "Native changing fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("Presentation must not run a model");
          },
          resolveSessionRuntimeOwnershipAsync: async (params) => {
            reads++;
            if (changing && change === "failure") {
              throw failure;
            }
            if (changing && (!changed || change === "continued")) {
              changed = true;
              const registration = registry.agentHarnesses[0]!;
              registration.harness = { ...registration.harness };
              params.assertCurrent?.();
            }
            return {
              model: "native",
              auth: "native",
              modelRef: { provider: "openai", model: "gpt-5.6-sol" },
            };
          },
        },
      });
      setActivePluginRegistry(registry);
      const release = retainSessionListForegroundWork();
      let projection: SessionRowProjection | undefined;
      try {
        projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        await projection.ensureMaterialized();
        changing = true;
        reads = 0;
        sessionChanges.emit({ agentId: "main", sessionKey: key, factsInvalidated: true });
        const respond = vi.fn();
        const request = sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "ownership-change-list", method: "sessions.list" },
          params: {},
          client: null,
          context: bindSessionRowProjection(requestContext(cfg), () => projection!),
          isWebchatConnect: () => false,
          respond,
        });
        if (change === "failure") {
          await expect(request).rejects.toBe(failure);
          expect(respond).not.toHaveBeenCalled();
        } else {
          await request;
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              sessions: [
                expect.objectContaining({
                  sessionId: "changing",
                  model: change === "continued" ? "gpt-5.5" : "gpt-5.6-sol",
                }),
                expect.objectContaining({ sessionId: "unaffected" }),
              ],
            }),
          );
          expect(reads).toBe(2);
          if (change === "continued") {
            changing = false;
            respond.mockClear();
            await sessionReadHandlers["sessions.list"]!({
              req: { type: "req", id: "ownership-stable-list", method: "sessions.list" },
              params: {},
              client: null,
              context: bindSessionRowProjection(requestContext(cfg), () => projection!),
              isWebchatConnect: () => false,
              respond,
            });
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                sessions: [
                  expect.objectContaining({ sessionId: "changing", model: "gpt-5.6-sol" }),
                  expect.objectContaining({ sessionId: "unaffected" }),
                ],
              }),
            );
            expect(reads).toBe(3);
          }
        }
      } finally {
        projection?.dispose();
        release();
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    });
  },
);

it("prepares native model ownership in workers and invalidates only its committed binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:session";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "gpt-5.6-sol");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "row-native-session",
        updatedAt: 1,
        agentHarnessId: "row-native",
        modelSelectionLocked: true,
      },
    );
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    let ownershipReads = 0;
    const syncOwnership = vi.fn(() => {
      throw new Error("Native row ownership must be read asynchronously");
    });
    registry.agentHarnesses.push({
      pluginId: "row-native",
      source: "test",
      harness: {
        id: "row-native",
        label: "Native row fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Session presentation must not run a model");
        },
        resolveSessionRuntimeOwnership: syncOwnership,
        resolveSessionRuntimeOwnershipAsync: async (params) => {
          ownershipReads++;
          const model = await bindings.lookup(params.sessionKey!);
          return model
            ? { model: "native", auth: "native", modelRef: { provider: "openai", model } }
            : undefined;
        },
      },
    });
    setActivePluginRegistry(registry);
    const releaseForeground = retainSessionListForegroundWork();
    let projection: SessionRowProjection | undefined;
    try {
      projection = await createSessionRowProjection({
        cfg: {
          agents: {
            entries: { main: {} },
            defaults: { model: { primary: "openai/gpt-5.5" } },
          },
        },
        modelCatalog: [],
      });
      await projection.ensureMaterialized();
      const snapshot = () => projection!.snapshot({ agentId: "main", key }).row;
      const sql = observeHostDataSql();
      try {
        expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
        expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const initialReads = ownershipReads;
      const source = projection.capture({ agentId: "main", key })?.runtimeOwnershipDependencies?.[0]
        ?.identity;
      expect(source).toBeDefined();
      const pending = beginPluginStatePublication(() => source!);
      try {
        await projection.ensureMaterialized();
        expect(snapshot()?.model).toBe("gpt-5.6-sol");
        expect(ownershipReads).toBe(initialReads);
      } finally {
        pending.finish("completed");
      }
      await bindings.register("unrelated", "gpt-5.6-luna");
      await projection.ensureMaterialized();
      expect(ownershipReads).toBe(initialReads);
      await bindings.register(key, "gpt-5.6-luna");
      await projection.ensureMaterialized();
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-luna" });
      await bindings.delete(key);
      await projection.ensureMaterialized();
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
      const beforeUnknown = ownershipReads;
      beginPluginStatePublication(() => source!).finish("unknown");
      await projection.ensureMaterialized();
      expect(ownershipReads).toBeGreaterThan(beforeUnknown);
      expect(snapshot()?.model).toBe("gpt-5.5");
      expect(syncOwnership).not.toHaveBeenCalled();
    } finally {
      projection?.dispose();
      releaseForeground();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  });
});
