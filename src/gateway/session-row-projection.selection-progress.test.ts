import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import * as membership from "./session-membership-projection.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  canRetainSessionRowRuntimeOwnership,
  isPreparedSessionRowDatabaseFacts,
} from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.for([
  { name: "off-page", options: {}, first: "response", keys: ["agent:main:visible"] },
  {
    name: "selected",
    options: { limit: 2 },
    first: "off-page ownership",
    keys: ["agent:main:visible", "agent:main:off-page"],
  },
  {
    name: "search",
    options: { search: "visible" },
    first: "off-page ownership",
    keys: ["agent:main:visible"],
  },
  {
    name: "without Board",
    options: { hasBoard: false },
    first: "off-page ownership",
    keys: ["agent:main:visible"],
  },
  {
    name: "with Board",
    options: { hasBoard: true },
    first: "off-page ownership",
    keys: [],
  },
])("preserves $name readiness when listing a sidebar page", async (scenario, { signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const visible = { agentId: "main", sessionKey: "agent:main:visible" };
    const offPage = { agentId: "main", sessionKey: "agent:main:off-page" };
    replaceSessionEntrySync(visible, {
      sessionId: "visible",
      updatedAt: 2,
      visibility: "shared",
    });
    const offPageEntry = {
      sessionId: "off-page",
      updatedAt: 1,
      visibility: "shared" as const,
      agentHarnessId: "sidebar-owner",
      modelSelectionLocked: true,
    };
    replaceSessionEntrySync(offPage, offPageEntry);
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let holdOwnership = false;
    registry.agentHarnesses.push({
      pluginId: "sidebar-owner",
      source: "test",
      harness: {
        id: "sidebar-owner",
        label: "Sidebar ownership fixture",
        supports: () => ({ supported: true }),
        async resolveSessionRuntimeOwnershipAsync({ assertCurrent }) {
          if (holdOwnership) {
            entered.resolve();
            await release.promise;
          }
          assertCurrent();
          return undefined;
        },
        async runAttempt() {
          throw new Error("Listing sessions must not run a model");
        },
      },
    });
    setActivePluginRegistry(registry);
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
    let reading: ReturnType<typeof listSessions> | undefined;
    try {
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const client = identifiedClient("sidebar-viewer");
      const request: SessionsListParams = { rowMode: "sidebar", limit: 1, ...scenario.options };
      expect(
        (
          await listSessions({
            context,
            client,
            request: { rowMode: "sidebar", limit: 1 },
          })
        ).sessions.map((row) => row.key),
      ).toEqual([visible.sessionKey]);
      const first = await projection.withSelectionPreparation(async () => {
        holdOwnership = true;
        replaceSessionEntrySync(offPage, { ...offPageEntry, label: "Renamed off-page" });
        const started = performance.now();
        reading = listSessions({ context, client, request, acceptsSerializedJson: true });
        const winner = await Promise.race([
          reading.then(() => "response" as const),
          entered.promise.then(() => "off-page ownership" as const),
        ]);
        console.info("sidebar-page-readiness", {
          scenario: scenario.name,
          first: winner,
          elapsedMs: performance.now() - started,
        });
        release.resolve();
        const result = await reading;
        expect(result.sessions.map((row) => row.key)).toEqual(scenario.keys);
        return winner;
      });
      expect(first).toBe(scenario.first);
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      projection?.dispose();
      restoreActivePluginRegistrySnapshot(previousRegistry);
      signal.removeEventListener("abort", abort);
    }
  });
});

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
