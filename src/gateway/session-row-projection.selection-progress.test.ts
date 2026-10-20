import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { cronTestJob } from "../cron/service.fixture-builders.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as plugins from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as reads from "./server-methods/sessions-read-cache.test-support.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import * as membership from "./session-membership-projection.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  canRetainSessionRowRuntimeOwnership,
  isPreparedSessionRowDatabaseFacts,
} from "./session-row-projection-record.js";
import * as rowFixture from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

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
      const cfg = { agents: { entries: { main: {} } } };
      const visible = { agentId: "main", sessionKey: visibleKey };
      const offPage = { agentId: "main", sessionKey: offPageKey };
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
          replaceSessionEntrySync(offPage, { ...offPageEntry, label: "Renamed off-page" });
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

// Opaque ownership must be re-read after invalidation; otherwise selection spins in microtasks.
it.each(["parent model change", "late cron registration"])(
  "settles selection of materialized opaque-ownership rows after %s",
  async (invalidation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
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
      const rows = keys.map((key) => projection.capture({ agentId: "main", key })!);
      const retained = rows.map((row) => row.retainedDatabaseFacts);

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
            createdAtMs: 1,
            updatedAtMs: 1,
            sessionTarget: `session:${key}`,
            wakeMode: "now",
            payload: { kind: "systemEvent", text: "Synthetic binding" },
          }),
        );
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
