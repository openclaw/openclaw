import { afterEach, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => resetConfigRuntimeState());

// Regression: a dirty row whose accepted facts carry opaque pinned-harness ownership must be
// re-read by selection preparation. Skipping it left preparation pending forever, and the
// empty-read loop spun in microtasks and starved the Gateway event loop (Team round 87).
it("re-reads dirty opaque-ownership rows instead of spinning selection preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    for (let index = 0; index < 3; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:opaque-${index}` },
        {
          sessionId: `opaque-${index}`,
          updatedAt: index + 1,
          agentHarnessId: "row-opaque",
          modelSelectionLocked: true,
        },
      );
    }
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    // A pinned harness without dependency-tracked ownership yields opaque ownership facts.
    registry.agentHarnesses.push({
      pluginId: "row-opaque",
      source: "test",
      harness: {
        id: "row-opaque",
        label: "Opaque ownership fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Session presentation must not run a model");
        },
      },
    });
    setActivePluginRegistry(registry);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      // Materialize the rows so each retains accepted database facts, as a served list does.
      await listProjectedSessions({ projection, opts: {} });
      expect(projection.dirtyRowCount).toBe(0);

      // A real config publication dirties every row without supplying fresh database facts.
      setRuntimeConfigSnapshot(structuredClone(cfg));
      expect(projection.dirtyRowCount).toBeGreaterThan(0);

      await projection.prepareSelection();
      expect(projection.needsSelectionPreparation()).toBe(false);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);
    } finally {
      projection.dispose();
      release();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  });
});
