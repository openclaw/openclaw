import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { AgentHarness } from "../agents/harness/types.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { cronTestJob } from "../cron/service.fixture-builders.test-support.js";
import type { CronJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as plugins from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as reads from "./server-methods/sessions-read-cache.test-support.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
} from "./session-automation-index.js";
import * as membership from "./session-membership-projection.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { ready } from "./session-row-projection-record.js";
import * as rowFixture from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());
const cfg = { agents: { entries: { main: {} } } };

function installHarness(
  id: string,
  resolveSessionRuntimeOwnershipAsync?: AgentHarness["resolveSessionRuntimeOwnershipAsync"],
) {
  const previous = plugins.captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: id,
    source: "test",
    harness: {
      id,
      label: "Session ownership fixture",
      supports: () => ({ supported: true }),
      ...(resolveSessionRuntimeOwnershipAsync ? { resolveSessionRuntimeOwnershipAsync } : {}),
      async runAttempt() {
        throw new Error("Session presentation must not run a model");
      },
    },
  });
  plugins.setActivePluginRegistry(registry);
  return { [Symbol.dispose]: () => plugins.restoreActivePluginRegistrySnapshot(previous) };
}

const visibleKey = "agent:main:visible",
  offPageKey = "agent:main:off-page";
it.for([
  ["off-page", {}, "response", [visibleKey]],
  ["selected", { limit: 2 }, "off-page ownership", [visibleKey, offPageKey]],
  ["search", { search: "visible" }, "off-page ownership", [visibleKey]],
  ["without Board", { hasBoard: false }, "off-page ownership", [visibleKey]],
  ["with Board", { hasBoard: true }, "off-page ownership", []],
] satisfies [string, SessionsListParams, string, string[]][])(
  "preserves %s readiness when listing a sidebar page",
  async ([, options, firstExpected, keys], { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const visible = { agentId: "main", sessionKey: visibleKey };
      rowFixture.seedRow(visibleKey, {
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
      rowFixture.seedRow(offPageKey, offPageEntry);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let holdOwnership = false;
      using _ = installHarness("sidebar-owner", async ({ assertCurrent }) => {
        if (holdOwnership) {
          entered.resolve();
          await release.promise;
        }
        assertCurrent();
        return undefined;
      });
      const abort = () => release.resolve();
      signal.addEventListener("abort", abort, { once: true });
      let projection: Awaited<ReturnType<typeof rowFixture.createTestProjection>> | undefined;
      let reading: ReturnType<typeof reads.listSessions> | undefined;
      try {
        projection = await rowFixture.createTestProjection({ cfg, modelCatalog: [] });
        const context = bindSessionRowProjection(reads.requestContext(cfg), () => projection);
        const client = reads.identifiedClient("sidebar-viewer");
        const request: SessionsListParams = { rowMode: "sidebar", limit: 1, ...options };
        const initial = await reads.listSessions({
          context,
          client,
          request: { rowMode: "sidebar", limit: 1 },
        });
        expect(initial.sessions.map((row) => row.key)).toEqual([visible.sessionKey]);
        const first = await projection.withSelectionPreparation(async () => {
          holdOwnership = true;
          rowFixture.seedRow(offPageKey, { ...offPageEntry, label: "Renamed off-page" });
          reading = reads.listSessions({ context, client, request, acceptsSerializedJson: true });
          const winner = await Promise.race([
            reading.then(() => "response" as const),
            entered.promise.then(() => "off-page ownership" as const),
          ]);
          release.resolve();
          const result = await reading;
          expect(result.sessions.map((row) => row.key)).toEqual(keys);
          return winner;
        });
        expect(first).toBe(firstExpected);
      } finally {
        release.resolve();
        await Promise.allSettled(reading ? [reading] : []);
        projection?.dispose();
        signal.removeEventListener("abort", abort);
      }
    });
  },
);

describe("automation bindings", () => {
  afterEach(() => registerSessionAutomationSource(null));

  it("rebuilds only changed automation bindings and preserves complete unrelated rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const keys = ["bound", "next", "parent", "other"].map((name) => `agent:main:${name}`);
      for (const [index, sessionKey] of keys.entries()) {
        rowFixture.seedRow(sessionKey, {
          sessionId: `session-${index}`,
          updatedAt: 1,
          ...(index === 0 ? { parentSessionKey: keys[2] } : {}),
        });
      }
      const jobs: CronJob[] = [];
      registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
      using projection = await rowFixture.createTestProjection({ cfg });
      const snapshot = () =>
        projection
          .selectEntries()
          .filter(ready)
          .map((row) => projection.present(row, { now: 1 }));
      await projection.ensureMaterialized();
      for (const key of keys) {
        projection.describe({ agentId: "main", key });
      }
      const before = snapshot();
      const databaseReads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const refresh = async (expectedCount: number, boundKey?: string) => {
        const count = projection.materializedCount;
        invalidateSessionAutomationIndex();
        await projection.ensureMaterialized();
        expect(projection.materializedCount - count).toBe(expectedCount);
        expect(snapshot()).toEqual(
          before.map((row) =>
            row.key === boundKey ? Object.assign({}, row, { hasAutomation: true }) : row,
          ),
        );
      };
      await refresh(0);
      const binding = cronTestJob({ id: "binding", sessionTarget: `session:${keys[0]}` });
      jobs.push(binding);
      await refresh(1, keys[0]);
      binding.sessionTarget = `session:${keys[1]}`;
      await refresh(2, keys[1]);
      expect(databaseReads).not.toHaveBeenCalled();
      expect(sharedReads).not.toHaveBeenCalled();
      const count = projection.materializedCount;
      sessionChanges.emit({ all: true, scope: "stores" });
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(keys.length);
      expect(databaseReads).toHaveBeenCalled();
    });
  });

  it("keeps automation aliases scoped to their logical agent in a shared store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const storePath = `${stateDir}/shared-sessions.json`;
      const sharedConfig = {
        session: { store: storePath, scope: "global" as const },
        agents: {
          entries: { main: {}, work: {} },
          defaults: { sessionStore: { agentId: "main" } },
        },
      };
      for (const agentId of ["main", "work"]) {
        rowFixture.seedRow(
          { agentId, storePath, key: "global" },
          { sessionId: `${agentId}-global`, updatedAt: 1 },
        );
      }
      const binding = cronTestJob({ id: "binding", sessionTarget: "main" });
      const jobs = [binding];
      registerSessionAutomationSource({
        getJobs: () => jobs,
        getDefaultAgentId: () => "main",
      });
      using projection = await rowFixture.createTestProjection({ cfg: sharedConfig });
      await projection.ensureMaterialized();
      projection.describe({ agentId: "main", key: "global", storePath });
      const work = projection.describe({ agentId: "work", key: "global", storePath });
      const count = projection.materializedCount;
      binding.enabled = false;
      invalidateSessionAutomationIndex();
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(1);
      expect(projection.describe({ agentId: "work", key: "global", storePath })).toBe(work);
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath }).row?.hasAutomation,
      ).toBeUndefined();
    });
  });
});

// Opaque ownership must be re-read after invalidation; otherwise selection spins in microtasks.
it.each(["parent model change", "late cron registration"])(
  "settles selection of materialized opaque-ownership rows after %s",
  async (invalidation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const parentKey = "agent:main:parent";
      const parent = { sessionId: "parent", updatedAt: 1 };
      const keys = Array.from({ length: 3 }, (_, index) => `agent:main:opaque-${index}`);
      rowFixture.seedRow(parentKey, parent);
      for (const [index, sessionKey] of keys.entries()) {
        rowFixture.seedRow(sessionKey, {
          sessionId: `opaque-${index}`,
          updatedAt: index + 1,
          agentHarnessId: "row-opaque",
          modelSelectionLocked: true,
          parentSessionKey: parentKey,
        });
      }
      using _ = installHarness("row-opaque");
      registerSessionAutomationSource(null);
      let preparationBudget = Infinity;
      const createMembership = membership.createSessionMembershipProjection;
      vi.spyOn(membership, "createSessionMembershipProjection").mockImplementation(() => {
        const owner = createMembership();
        const prepare = owner.prepare;
        // Bound preparation passes: microtask spins starve timer-based watchdogs.
        vi.spyOn(owner, "prepare").mockImplementation(() => {
          if (--preparationBudget < 0) {
            throw new Error("Selection preparation made no progress after 8 passes");
          }
          return prepare();
        });
        return owner;
      });
      using cleanup = new DisposableStack();
      cleanup.defer(() => registerSessionAutomationSource(null));
      cleanup.use(rowFixture.holdForeground());
      const projection = await rowFixture.createTestProjection({ cfg, modelCatalog: [] });
      cleanup.use(projection);
      await listProjectedSessions({ projection, opts: {} });
      expect(projection.dirtyRowCount).toBe(0);
      expect(projection.needsSelectionPreparation()).toBe(false);

      if (invalidation === "parent model change") {
        rowFixture.seedRow(parentKey, {
          ...parent,
          providerOverride: "unit-test",
          modelOverride: "changed",
        });
      } else {
        const jobs = keys.map((key, index) =>
          cronTestJob({
            id: `binding-${index}`,
            sessionTarget: `session:${key}`,
          }),
        );
        registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
      }
      expect(projection.dirtyRowCount).toBeGreaterThanOrEqual(keys.length);
      expect(projection.needsSelectionPreparation()).toBe(true);

      preparationBudget = 8;
      try {
        await projection.prepareSelection();
      } finally {
        preparationBudget = Infinity;
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
    });
  },
);
