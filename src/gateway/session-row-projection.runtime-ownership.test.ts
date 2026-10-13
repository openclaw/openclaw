import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createPluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      await bindings.register("unrelated", "gpt-5.6-luna");
      await projection.ensureMaterialized();
      expect(ownershipReads).toBe(initialReads);
      await bindings.register(key, "gpt-5.6-luna");
      await projection.ensureMaterialized();
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-luna" });
      await bindings.delete(key);
      await projection.ensureMaterialized();
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
      expect(syncOwnership).not.toHaveBeenCalled();
    } finally {
      projection?.dispose();
      releaseForeground();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  });
});
