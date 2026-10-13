import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import * as membership from "./session-membership-projection.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import {
  canRetainSessionRowRuntimeOwnership,
  isPreparedSessionRowDatabaseFacts,
} from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

// Regression: a dirty row whose accepted facts carry opaque pinned-harness ownership must be
// re-read by selection preparation. Skipping it left preparation pending forever, and the
// empty-read loop spun in microtasks and starved the Gateway event loop.
it.each(["parent model change", "late cron registration"])(
  "settles selection of materialized opaque-ownership rows after %s",
  async (invalidation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const parentKey = "agent:main:parent";
      const parent = { sessionId: "parent", updatedAt: 1 };
      const keys = Array.from({ length: 3 }, (_, index) => `agent:main:opaque-${index}`);
      replaceSessionEntrySync({ agentId: "main", sessionKey: parentKey }, parent);
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: `opaque-${index}`,
            updatedAt: index + 1,
            agentHarnessId: "row-opaque",
            modelSelectionLocked: true,
            parentSessionKey: parentKey,
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
      registerSessionAutomationSource(null);
      let preparationPasses = 0;
      let guardSelection = false;
      const createMembership = membership.createSessionMembershipProjection;
      vi.spyOn(membership, "createSessionMembershipProjection").mockImplementation(() => {
        const owner = createMembership();
        const prepare = owner.prepare;
        // A microtask spin starves timers. Bound loop passes at a real awaited boundary,
        // preserving membership preparation so the regression rejects instead of hanging.
        vi.spyOn(owner, "prepare").mockImplementation(() => {
          if (guardSelection && ++preparationPasses > 8) {
            throw new Error("Selection preparation made no progress after 8 passes");
          }
          return prepare();
        });
        return owner;
      });
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      try {
        // Materialize the rows so each retains accepted database facts, as a served list does.
        await listProjectedSessions({ projection, opts: {} });
        expect(projection.dirtyRowCount).toBe(0);
        expect(projection.needsSelectionPreparation()).toBe(false);
        const rows = keys.map((key) => projection.capture({ agentId: "main", key })!);
        const retained = rows.map((row) => row.retainedDatabaseFacts);

        if (invalidation === "parent model change") {
          // Parent publication fans out through archive.markRelated without expiring child facts.
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: parentKey },
            { ...parent, providerOverride: "unit-test", modelOverride: "changed" },
          );
        } else {
          // server-cron registers after startup; loaded bindings re-dirty already served rows.
          const jobs: CronJob[] = keys.map((key, index) => ({
            id: `binding-${index}`,
            name: `Binding ${index}`,
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: `session:${key}`,
            wakeMode: "now",
            payload: { kind: "systemEvent", text: "Synthetic binding" },
            state: {},
          }));
          registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
        }
        expect(projection.dirtyRowCount).toBeGreaterThanOrEqual(keys.length);
        for (const [index, row] of rows.entries()) {
          expect(projection.capture({ agentId: "main", key: row.key })).toBe(row);
          expect(row.materialized).toBeDefined();
          expect(row.pendingDatabaseFacts).toBeUndefined();
          expect(row.retainedDatabaseFacts).toBe(retained[index]);
          const facts = row.retainedDatabaseFacts;
          expect(isPreparedSessionRowDatabaseFacts(facts)).toBe(true);
          if (!isPreparedSessionRowDatabaseFacts(facts)) {
            throw new Error("Expected prepared retained database facts");
          }
          expect(facts.entry).toMatchObject({
            agentHarnessId: "row-opaque",
            modelSelectionLocked: true,
          });
          expect(facts.runtimeOwnershipDependencies).toEqual([]);
          expect(canRetainSessionRowRuntimeOwnership(facts)).toBe(false);
        }
        expect(projection.needsSelectionPreparation()).toBe(true);

        guardSelection = true;
        try {
          await projection.prepareSelection();
        } finally {
          guardSelection = false;
        }
        expect(projection.needsSelectionPreparation()).toBe(false);
        const listed = await listProjectedSessions({ projection, opts: {} });
        expect(projection.dirtyRowCount).toBe(0);
        expect(listed.sessions.map((row) => row.key)).toEqual(expect.arrayContaining(keys));
        for (const key of keys) {
          expect(listed.sessions.find((row) => row.key === key)).toMatchObject(
            invalidation === "parent model change"
              ? { modelProvider: "unit-test", model: "changed" }
              : { hasAutomation: true },
          );
        }
      } finally {
        projection.dispose();
        release();
        registerSessionAutomationSource(null);
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    });
  },
);
