// Session utility performance tests protect resolver cache scaling for large
// session lists with repeated provider/model tuples.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, test, expect, vi } from "vitest";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import * as modelCatalogLookup from "../agents/model-catalog-lookup.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import * as sessionModelRef from "../agents/session-model-ref.js";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import * as usageFormat from "../utils/usage-format.js";
import type { GatewayClient } from "./server-methods/types.js";
import * as sessionOrder from "./session-list-order.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import * as projectionWork from "./session-projection-work.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import * as titleReader from "./session-transcript-title-reader.js";
import { resolveEstimatedSessionCostUsd } from "./session-utils-core.js";
import { filterAndSortSessionEntries, listProjectedSessions } from "./session-utils-list.js";
import {
  projectSessionPatchResult,
  resolveGatewaySessionThinkingProjectionInternal,
} from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import * as rowProjection from "./session-utils-row.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

/**
 * Regression smoke for the per-list rowContext resolver cache. The bug we are
 * guarding against is O(rows) scaling of deterministic resolvers whose results
 * only depend on `(provider, model[, agentId])`: with N sessions sharing K
 * unique model tuples, the cached path must perform at most O(K) underlying
 * resolver calls -- not O(N).
 *
 * We assert call counts directly instead of a wall-time bound because shared
 * CI runners cannot give a stable wall-time signal, and call-count regressions
 * are the actual scaling failure mode we care about.
 */
describe("session list resolver cache", () => {
  test("bounds first-page comparisons while preserving the latest-row order", async () => {
    await withStateDirEnv("openclaw-list-order-work-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" } },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const count = 256;
      const store = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `agent:main:ordered-${index}`,
          { sessionId: `ordered-${index}`, updatedAt: ((index * 71) % count) + 1 },
        ]),
      );
      writeResidentEntries(store);
      const projection = await createSessionRowProjection({ cfg });
      try {
        await projection.ensureMaterialized();
        const compare = vi.spyOn(sessionOrder, "compareSessionEntryPairs");
        try {
          const result = await listProjectedSessions({ projection, opts: { limit: 5 } });
          expect(result.sessions.map((row) => row.key)).toEqual(
            Object.entries(store)
              .toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)
              .slice(0, 5)
              .map(([key]) => key),
          );
          expect(result.totalCount).toBe(count);
          expect(compare.mock.calls.length).toBeLessThanOrEqual(count * 4);
        } finally {
          compare.mockRestore();
        }
      } finally {
        projection.dispose();
      }
    });
  });

  test.each(["entries", "list"] as const)(
    "bounds owner roster traversal for %s and observes the next request's roster",
    (kind) => {
      let rosterReads = 0;
      const agents = Array.from({ length: 30 }, (_, index) => ({
        get id() {
          rosterReads++;
          return `agent-${index}`;
        },
        identity: { name: `Agent ${index}` },
      }));
      const entries = Object.fromEntries(
        agents.map((agent, index) => [`agent-${index}`, { identity: agent.identity }]),
      );
      for (const [id, entry] of Object.entries(entries)) {
        Object.defineProperty(entries, id, {
          configurable: true,
          get: () => {
            rosterReads++;
            return entry;
          },
        });
      }
      const cfg: OpenClawConfig = { agents: kind === "entries" ? { entries } : { list: agents } };
      const store = Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `agent:agent-29:dashboard:${index}`,
          {
            sessionId: `owned-${index}`,
            updatedAt: index + 1,
            createdActor: { type: "agent" as const, id: "agent-29" },
          },
        ]),
      );
      const select = () =>
        filterAndSortSessionEntries({
          cfg,
          entries: Object.entries(store),
          getTarget: (key) => ({
            agentId: "agent-29",
            selection: readSessionListSelectionFacts(key, store[key]),
          }),
          getRowContext: () => buildSessionListRowMetadataContext({ now: 100 }),
          now: 100,
          opts: { ownerId: "agent-29", limit: 10 },
        });
      rosterReads = 0;
      expect(select().map(([key]) => key)).toEqual(Object.keys(store).toReversed().slice(0, 10));
      expect(rosterReads).toBeLessThanOrEqual(agents.length * 3);
      if (kind === "entries") {
        delete entries["agent-29"];
      } else {
        cfg.agents!.list = agents.slice(0, -1);
      }
      expect(select()).toEqual([]);
    },
  );

  test.each([
    { phase: "startup", rosterSize: 30 },
    { phase: "dirty refresh", rosterSize: 32 },
  ])(
    "bounds $phase roster work and observes config publication across a yield",
    async ({ phase, rosterSize }) => {
      await withStateDirEnv("openclaw-roster-chunks-", async () => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const rowCount = 80;
        const ownerId = `agent-${rosterSize - 1}`;
        const entries = Object.fromEntries(
          Array.from({ length: rosterSize }, (_, index) => [
            `agent-${index}`,
            { identity: { name: `Agent ${index}` }, fastModeDefault: false },
          ]),
        );
        let insideRow = false;
        let rowReads = 0;
        const cfg: OpenClawConfig = {
          agents: {
            entries: new Proxy(entries, {
              get(target, key, receiver) {
                if (insideRow && typeof key === "string" && Object.hasOwn(target, key)) {
                  rowReads++;
                }
                return Reflect.get(target, key, receiver);
              },
            }),
            defaults: { model: { primary: "example/roster-model" }, thinkingDefault: "off" },
          },
        };
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        const store = Object.fromEntries(
          Array.from({ length: rowCount }, (_, index) => [
            `agent:${ownerId}:dashboard:${index}`,
            {
              sessionId: `row-chunk-${index}`,
              updatedAt: index + 1,
              createdActor: { type: "agent" as const, id: ownerId },
            },
          ]),
        );
        writeResidentEntries(store);
        let projection: SessionRowProjection | undefined;
        let refreshBatch = 0;
        const createDrain = projectionWork.createSessionProjectionDrain;
        const drains = vi
          .spyOn(projectionWork, "createSessionProjectionDrain")
          .mockImplementation((params) =>
            createDrain({
              ...params,
              refresh() {
                refreshBatch++;
                return params.refresh();
              },
            }),
          );
        try {
          if (phase === "dirty refresh") {
            projection = await createSessionRowProjection({ cfg });
          }
          let projectedRows = 0;
          let rowsBeforePause = 0;
          let identityDuringPause: string | undefined;
          let control: Promise<void> | undefined;
          const rowBatches = new Set<number>();
          const buildRow = rowProjection.readSessionRowInputs;
          const rows = vi
            .spyOn(rowProjection, "readSessionRowInputs")
            .mockImplementation((params) => {
              rowBatches.add(refreshBatch);
              insideRow = true;
              try {
                return buildRow(params);
              } finally {
                insideRow = false;
                projectedRows++;
                if (projectedRows === 1) {
                  control = new Promise<void>((resolve) => {
                    setImmediate(() => {
                      rowsBeforePause = projectedRows;
                      entries[ownerId] = {
                        identity: { name: "Refreshed owner" },
                        fastModeDefault: true,
                      };
                      sessionChanges.emit({ all: true, scope: "config" });
                      identityDuringPause = resolveAgentIdentity(cfg, ownerId)?.name;
                      resolve();
                    });
                  });
                }
              }
            });
          try {
            if (projection) {
              writeResidentEntries(store, 1);
              await projection.ensureMaterialized();
            } else {
              projection = await createSessionRowProjection({ cfg });
            }
            const result = await listProjectedSessions({ projection, opts: { limit: rowCount } });
            expect(result.count).toBe(rowCount);
            expect(result.totalCount).toBe(rowCount);
            expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
            expect(rowsBeforePause).toBeGreaterThan(0);
            expect(rowsBeforePause).toBeLessThan(rowCount);
            expect(identityDuringPause).toBe("Refreshed owner");
            expect(result.sessions.every((row) => row.effectiveFastMode === true)).toBe(true);
            expect(result.owners?.find((owner) => owner.id === ownerId)?.label).toBe(
              "Refreshed owner",
            );
            expect(rowBatches.size).toBeGreaterThan(1);
            expect(rowReads).toBeLessThanOrEqual(rosterSize * rowBatches.size * 3);
            rows.mockClear();
            await listProjectedSessions({ projection, opts: { limit: rowCount } });
            expect(rows).not.toHaveBeenCalled();
          } finally {
            rows.mockRestore();
            await control;
          }
        } finally {
          drains.mockRestore();
          projection?.dispose();
        }
      });
    },
  );

  test.each([
    { phase: "startup", cost: "acquisition" },
    { phase: "startup", cost: "materialization" },
    { phase: "dirty refresh", cost: "acquisition" },
    { phase: "dirty refresh", cost: "materialization" },
  ])(
    "yields during expensive $phase $cost without reacquiring unchanged rows",
    async ({ phase, cost }) => {
      await withStateDirEnv("openclaw-row-work-budget-", async () => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" } },
        };
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        const rowCount = 96;
        const store = Object.fromEntries(
          Array.from({ length: rowCount }, (_, index) => [
            `agent:main:budget-${index}`,
            { sessionId: `budget-${index}`, updatedAt: index + 1 },
          ]),
        );
        writeResidentEntries(store);
        let projection: SessionRowProjection | undefined;
        if (phase === "dirty refresh") {
          projection = await createSessionRowProjection({ cfg });
        }
        let workMs = 0;
        let projectedRows = 0;
        let acquiredRows = 0;
        let rowsAtControl = 0;
        let control: Promise<void> | undefined;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
        const readEntryCache = entryCache.readCommittedSessionEntryCache;
        const acquisitions = vi
          .spyOn(entryCache, "readCommittedSessionEntryCache")
          .mockImplementation((...args) => {
            acquiredRows++;
            if (cost === "acquisition") {
              workMs += 20;
            }
            return readEntryCache(...args);
          });
        const readInputs = rowProjection.readSessionRowInputs;
        const rows = vi
          .spyOn(rowProjection, "readSessionRowInputs")
          .mockImplementation((params) => {
            const result = readInputs(params);
            if (cost === "materialization") {
              workMs += 20;
            }
            projectedRows++;
            if (projectedRows === 1) {
              control = new Promise<void>((resolve) => {
                setImmediate(() => {
                  rowsAtControl = projectedRows;
                  resolve();
                });
              });
            }
            return result;
          });
        try {
          if (projection) {
            writeResidentEntries(store, 1);
            await projection.ensureMaterialized();
          } else {
            projection = await createSessionRowProjection({ cfg });
          }
          await control;
          await projection.ensureMaterialized();
          expect(rowsAtControl).toBeGreaterThan(0);
          expect(rowsAtControl).toBeLessThan(rowCount);
          expect(projectedRows).toBe(rowCount);
          expect(acquiredRows).toBeLessThanOrEqual(rowCount * 2);
          rows.mockClear();
          const result = await listProjectedSessions({ projection, opts: { limit: rowCount } });
          expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
          expect(rows).not.toHaveBeenCalled();
        } finally {
          rows.mockRestore();
          acquisitions.mockRestore();
          clock.mockRestore();
          await control;
          projection?.dispose();
        }
      });
    },
  );

  test("restores an enclosing roster batch after nested selection and failure", () => {
    let ownerEntry = { identity: { name: "Outer owner" } };
    let outerReads = 0;
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          get owner() {
            outerReads++;
            return ownerEntry;
          },
        },
      },
    };
    const nested: OpenClawConfig = {
      agents: { entries: { owner: { identity: { name: "Nested owner" } } } },
    };
    const store = {
      "agent:owner:dashboard:nested": {
        sessionId: "nested",
        updatedAt: 1,
        createdActor: { type: "agent" as const, id: "owner" },
      },
    };
    withAgentRosterFactsBatch(cfg, () => {
      const identity = resolveAgentIdentity(cfg, "owner");
      for (const selectionConfig of [cfg, nested]) {
        expect(
          filterAndSortSessionEntries({
            cfg: selectionConfig,
            entries: Object.entries(store),
            getTarget: (key) => ({
              agentId: "owner",
              selection: readSessionListSelectionFacts(key),
            }),
            getRowContext: () => buildSessionListRowMetadataContext({ now: 2 }),
            now: 2,
            opts: {},
          }),
        ).toEqual(Object.entries(store));
        expect(() =>
          filterAndSortSessionEntries({
            cfg: selectionConfig,
            entries: Object.entries(store),
            getTarget: (key) => ({
              agentId: "owner",
              selection: readSessionListSelectionFacts(key),
            }),
            getRowContext: () => buildSessionListRowMetadataContext({ now: 2 }),
            now: 2,
            opts: {},
            entryFilter: () => {
              expect(resolveAgentIdentity(selectionConfig, "owner")?.name).toBe(
                selectionConfig === cfg ? "Outer owner" : "Nested owner",
              );
              throw new Error("selection stopped");
            },
          }),
        ).toThrow("selection stopped");
        const readsBeforeOuterLookup = outerReads;
        expect(resolveAgentIdentity(cfg, "owner")).toBe(identity);
        expect(outerReads).toBe(readsBeforeOuterLookup);
      }
    });
    ownerEntry = { identity: { name: "Next request" } };
    expect(resolveAgentIdentity(cfg, "owner")?.name).toBe("Next request");
  });

  test.each([undefined, "unmatched-model-search"])(
    "resolves configured defaults once per agent for search %s",
    async (search) => {
      await withStateDirEnv("openclaw-perf-default-model-", async () => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const cfg: OpenClawConfig = {
          agents: {
            entries: {
              main: { model: "openai/gpt-5" },
              work: { model: "anthropic/claude-sonnet-4-6" },
            },
            defaults: { thinkingDefault: "off" },
          },
        };
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        const store: Record<string, SessionEntry> = Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => {
            const agentId = index % 2 === 0 ? "main" : "work";
            return [
              `agent:${agentId}:default-${index}`,
              {
                sessionId: `default-${index}`,
                updatedAt: index + 1,
                modelProvider: "openai",
                model: "previous-run-model",
              },
            ];
          }),
        );
        writeResidentEntries(store);
        const resolver = vi.spyOn(sessionModelRef, "resolveSessionModelRefCore");
        let projection: SessionRowProjection | undefined;
        try {
          projection = await createSessionRowProjection({ cfg });
          await projection.ensureMaterialized();
          expect(resolver).toHaveBeenCalledTimes(2);
          resolver.mockClear();
          for (let request = 0; request < 2; request++) {
            const result = await listProjectedSessions({
              projection,
              opts: { limit: 40, ...(search ? { search } : {}) },
            });
            expect(result.count).toBe(search ? 0 : 40);
            for (const row of result.sessions) {
              expect([row.modelProvider, row.model]).toEqual(
                row.agentId === "main" ? ["openai", "gpt-5"] : ["anthropic", "claude-sonnet-4-6"],
              );
            }
          }
          expect(resolver).not.toHaveBeenCalled();
        } finally {
          projection?.dispose();
          resolver.mockRestore();
        }
      });
    },
  );

  test("bounds catalog acquisition per publication and reuses each agent's model metadata", async () => {
    await withStateDirEnv("openclaw-perf-catalog-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      const pluginRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(pluginRegistry);
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {}, research: {} },
          defaults: { model: { primary: "example/model-hit" } },
        },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const modelCatalog = new Map(
        ["main", "research"].map((agentId, index) => [
          agentId,
          {
            entries: ["model-hit", "Model-Hit"].map((id, modelIndex) => {
              const contextTokens = (index + 1) * (modelIndex + 1) * 10_000;
              return {
                provider: "example",
                id,
                name: "Example model",
                contextTokens,
                contextWindows: [{ id: "full", label: "Full", contextWindow: contextTokens }],
                contextWindowDefault: "full",
              };
            }),
            pluginRegistry,
          },
        ]),
      );
      const store = Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => {
          const agentId = index % 2 ? "research" : "main";
          return [
            `agent:${agentId}:dashboard:catalog-${index}`,
            {
              sessionId: `catalog-${index}`,
              updatedAt: index,
              providerOverride: "example",
              modelOverride:
                index % 8 < 2 ? "model-hit" : index % 8 < 4 ? "Model-Hit" : "model-missing",
              ...(index % 8 < 2
                ? {
                    acp: {
                      backend: "acpx",
                      agent: agentId,
                      runtimeSessionName: `catalog-${index}`,
                      mode: "persistent" as const,
                      state: "idle" as const,
                      lastActivityAt: index,
                    },
                  }
                : {}),
            } satisfies SessionEntry,
          ];
        }),
      );
      writeResidentEntries(store);
      const catalogSpy = vi.spyOn(modelCatalogLookup, "findModelCatalogEntry");
      let projection: SessionRowProjection | undefined;
      try {
        for (const revision of [1, 2]) {
          for (const [agentId, catalog] of modelCatalog) {
            catalog.entries.forEach((entry, index) => {
              const contextTokens = revision * (index + 1) * (agentId === "main" ? 10_000 : 20_000);
              catalog.entries[index] = {
                ...entry,
                contextTokens,
                contextWindows: [{ id: "full", label: "Full", contextWindow: contextTokens }],
              };
            });
          }
          catalogSpy.mockClear();
          if (projection) {
            notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
            await projection.ensureMaterialized();
          } else {
            projection = await createSessionRowProjection({
              cfg,
              modelCatalog,
              getModelCatalog: async () => modelCatalog,
            });
          }
          const result = await listProjectedSessions({ projection, opts: { limit: 80 } });
          expect(result.count).toBe(80);
          const catalogRows = result.sessions.filter(
            (row) => row.model?.toLowerCase() === "model-hit",
          );
          expect(catalogRows).toHaveLength(40);
          for (const row of catalogRows) {
            expect(row.contextTokens).toBe(
              revision *
                (row.model === "Model-Hit" ? 2 : 1) *
                (row.agentId === "main" ? 10_000 : 20_000),
            );
            expect(row).not.toHaveProperty("catalogEntry");
          }
          // Acquisition shares both hits and misses; defaults retain their separate lookup.
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(10);
          const inputs = vi.spyOn(rowProjection, "readSessionRowInputs");
          try {
            await listProjectedSessions({ projection, opts: { limit: 80 } });
            expect(inputs).not.toHaveBeenCalled();
          } finally {
            inputs.mockRestore();
          }
          catalogSpy.mockClear();
          const key = "agent:main:dashboard:catalog-0";
          const patch = projectSessionPatchResult({
            cfg,
            canonicalKey: key,
            targetAgentId: "main",
            entry: store[key]!,
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
            modelCatalog: modelCatalog.get("main")!.entries,
          });
          expect(patch.resolved).toMatchObject({
            contextWindow: "full",
            contextWindows: [{ id: "full", label: "Full", contextWindow: revision * 10_000 }],
          });
          expect(patch.resolved).not.toHaveProperty("catalogEntry");
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(2);
        }
      } finally {
        projection?.dispose();
        catalogSpy.mockRestore();
      }
    });
  });

  test.each([
    {
      name: "cheap rows",
    },
    {
      name: "expensive rows",
      rowWorkMs: 20,
    },
    {
      name: "one row after expensive preparation",
      preparationWorkMs: 1,
      limit: 1,
    },
    {
      name: "an empty page after expensive preparation",
      preparationWorkMs: 1,
      keepRows: false,
      limit: 1,
    },
    {
      name: "one row after combined loading and preparation",
      storeWorkMs: 8,
      preparationWorkMs: 0.25,
      limit: 1,
    },
    {
      name: "one row after expensive store loading",
      storeWorkMs: 20,
      limit: 1,
    },
    {
      name: "wide ordering",
      orderingWorkMs: 1,
      limit: 300,
    },
    { name: "wide ACP metadata preparation", metadataWorkMs: 1, limit: 600 },
    { name: "runtime-search ACP metadata", metadataWorkMs: 1, search: "unmatched", limit: 1 },
  ])(
    "reuses resident input facts for $name without a request-time yield",
    async ({
      rowWorkMs = 0,
      storeWorkMs = 0,
      preparationWorkMs = 0,
      orderingWorkMs = 0,
      metadataWorkMs = 0,
      search,
      keepRows = true,
      limit = 100,
    }) => {
      await withStateDirEnv("openclaw-list-work-budget-", async ({ stateDir }) => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const cfg: OpenClawConfig = {};
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        const entryCount = orderingWorkMs > 0 ? 2051 : metadataWorkMs > 0 ? 600 : 32;
        const store = Object.fromEntries(
          Array.from({ length: entryCount }, (_, index) => [
            `agent:main:budget-${index}`,
            { sessionId: `budget-${index}`, updatedAt: index + 1 },
          ]),
        );
        const projection = createSessionRowProjectionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
        });
        let workMs = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
        const readInputs = rowProjection.readSessionRowInputs;
        const rows = vi
          .spyOn(rowProjection, "readSessionRowInputs")
          .mockImplementation((params) => {
            // The former acquisition charges must never be incurred by a clean request.
            workMs += rowWorkMs + storeWorkMs + preparationWorkMs + metadataWorkMs + orderingWorkMs;
            return readInputs(params);
          });
        let controlRan = false;
        const control = new Promise<void>((resolve) => {
          setImmediate(() => {
            controlRan = true;
            resolve();
          });
        });
        try {
          for (let request = 0; request < 2; request++) {
            const result = await listProjectedSessions({
              projection,
              opts: { limit, search: search ?? (keepRows ? undefined : "unmatched-budget") },
            });
            expect(result.sessions.map((row) => row.key)).toEqual(
              keepRows && !search ? Object.keys(store).toReversed().slice(0, limit) : [],
            );
            expect(controlRan).toBe(false);
            expect(rows).not.toHaveBeenCalled();
            expect(workMs).toBe(0);
          }
        } finally {
          rows.mockRestore();
          clock.mockRestore();
          projection.dispose();
          await control;
        }
      });
    },
  );

  test.each([
    { name: "legacy flat estimate", recorded: undefined, tiered: false, expected: 0.00015 },
    { name: "recorded per-call total", recorded: 0.25, tiered: true, expected: 0.25 },
    { name: "recorded zero", recorded: 0, tiered: true, expected: 0 },
    { name: "unknown tiered total", recorded: undefined, tiered: true, expected: undefined },
  ])("bounds resolver work and preserves $name", ({ recorded, tiered, expected }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "google-vertex/gemini-3-flash-preview" },
          thinkingDefault: "off",
        },
      },
    } as OpenClawConfig;
    const tuples: Array<{ modelProvider: string; model: string }> = [
      { modelProvider: "google-vertex", model: "gemini-3-flash-preview" },
      { modelProvider: "openai", model: "gpt-5" },
      { modelProvider: "anthropic", model: "claude-opus-4-7" },
      { modelProvider: "openrouter", model: "z-ai/glm-5" },
      { modelProvider: "google", model: "gemini-2.5-pro" },
    ];
    const now = Date.now();
    const rowCount = 30;
    const catalog = tuples.map(({ modelProvider, model }) => ({
      provider: modelProvider,
      id: model,
      name: model,
      reasoning: true,
    }));
    const rowContext = buildSessionListRowMetadataContext({ now });
    const catalogSpy = vi.spyOn(modelCatalogLookup, "findModelCatalogEntry");
    const thinkingSpy = vi
      .spyOn(thinking, "resolveThinkingProfile")
      .mockReturnValue({ levels: [{ id: "off", label: "Off", rank: 0 }], defaultLevel: "off" });
    const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig").mockReturnValue({
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      ...(tiered
        ? {
            tieredPricing: [
              {
                input: 2,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                range: [0, Infinity] as [number, number],
              },
            ],
          }
        : {}),
    });
    try {
      for (let index = 0; index < rowCount; index += 1) {
        const tuple = expectDefined(
          tuples[index % tuples.length],
          "tuples[index % tuples.length] test invariant",
        );
        const sessionKey = `agent:default:webchat:dm:${index}`;
        const entry: SessionEntry = {
          sessionId: `cache-proof-${index}`,
          updatedAt: now - index,
          modelProvider: tuple.modelProvider,
          model: tuple.model,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: recorded,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: sessionKey,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: now,
          },
        };
        expect(
          resolveGatewaySessionThinkingProjectionInternal({
            cfg,
            agentId: "default",
            provider: tuple.modelProvider,
            model: tuple.model,
            sessionKey,
            entry,
            modelCatalog: catalog,
            rowContext,
          }).thinkingOptions,
        ).toEqual(["Off"]);
        const resolvedCost = resolveEstimatedSessionCostUsd({
          cfg,
          provider: tuple.modelProvider,
          model: tuple.model,
          entry,
          rowContext,
        });
        if (expected !== undefined) {
          expect(resolvedCost).toBeCloseTo(expected, 10);
        } else {
          expect(resolvedCost).toBeUndefined();
        }
      }

      // Recorded prices bypass lookup; legacy fallback still scales by model, not row.
      expect(thinkingSpy).toHaveBeenCalledTimes(tuples.length);
      expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(tuples.length);
      expect(costSpy).toHaveBeenCalledTimes(recorded !== undefined ? 0 : tuples.length);
    } finally {
      thinkingSpy.mockRestore();
      catalogSpy.mockRestore();
      costSpy.mockRestore();
    }
  });

  test.each([
    { name: "ordinary", count: 30, owned: 0, limit: 30, rows: 30, enriched: 30, sharedTail: 29 },
    {
      name: "retained owner-first",
      count: 480,
      owned: 240,
      limit: 240,
      rows: 300,
      enriched: 160,
      sharedTail: 99,
    },
  ])(
    "bounds $name transcript fields without starving shared rows or rereading transcripts",
    async (scenario) => {
      await withStateDirEnv("openclaw-perf-title-batch-", async ({ stateDir }) => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const cfg = {
          agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
        } as OpenClawConfig;
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        const storePath = path.join(stateDir, "sessions.json");
        const store: Record<string, SessionEntry> = {};
        const ownerId = scenario.owned ? ensureProfileForEmail("owner@example.com").id : undefined;
        for (let index = 0; index < scenario.count; index += 1) {
          const sessionId = `title-batch-${index}`;
          const sessionKey = `agent:main:${sessionId}`;
          const entry: SessionEntry = {
            sessionId,
            updatedAt: 1_000 - index,
            ...(ownerId && index >= scenario.count - scenario.owned
              ? {
                  createdVia: "operator",
                  createdActor: { type: "human", source: "profile", id: ownerId },
                }
              : {}),
          };
          store[sessionKey] = entry;
        }

        const titleSpy = vi
          .spyOn(titleReader, "readSessionTitleFieldsFromTranscript")
          .mockImplementation((scope) => ({
            firstUserMessage: `title ${scope.sessionId.slice("title-batch-".length)}`,
            lastMessagePreview: `last ${scope.sessionId.slice("title-batch-".length)}`,
          }));
        let projection: ReturnType<typeof createSessionRowProjectionFixture> | undefined;
        const client: GatewayClient | undefined = ownerId
          ? {
              connect: {
                minProtocol: 1,
                maxProtocol: 1,
                client: {
                  id: "openclaw-control-ui",
                  version: "test",
                  platform: "test",
                  mode: "webchat",
                },
                role: "operator",
                scopes: ["operator.admin"],
              },
              authenticatedUserProfile: {
                profileId: ownerId,
                displayName: ownerId,
                hasAvatar: false,
                updatedAt: 1,
              },
              preparedSessionProfile: {
                profileId: ownerId,
                aliases: new Set([ownerId]),
                role: null,
              },
            }
          : undefined;
        try {
          projection = createSessionRowProjectionFixture({ cfg, storePath, store });
          titleSpy.mockClear();
          const result = await listProjectedSessions({
            projection,
            client,
            opts: {
              ownerFirst: Boolean(ownerId),
              includeDerivedTitles: true,
              includeLastMessage: true,
              limit: scenario.limit,
            },
          });

          expect(result.sessions).toHaveLength(scenario.rows);
          expect(titleSpy).not.toHaveBeenCalled();
          expect(result.sessions.filter((row) => row.derivedTitle !== undefined)).toHaveLength(
            scenario.enriched,
          );
          expect(
            result.sessions.filter((row) => row.lastMessagePreview !== undefined),
          ).toHaveLength(scenario.enriched);
          const sessionsByKey = new Map(result.sessions.map((session) => [session.key, session]));
          expect(sessionsByKey.get("agent:main:title-batch-0")).toMatchObject({
            derivedTitle: "Title 0",
            lastMessagePreview: "last 0",
          });
          expect(sessionsByKey.get(`agent:main:title-batch-${scenario.sharedTail}`)).toMatchObject({
            derivedTitle: `Title ${scenario.sharedTail}`,
            lastMessagePreview: `last ${scenario.sharedTail}`,
          });

          const withoutTranscriptFields = await listProjectedSessions({
            projection,
            client,
            opts: {
              ownerFirst: Boolean(ownerId),
              includeDerivedTitles: false,
              includeLastMessage: false,
              limit: scenario.limit,
            },
          });
          expect(titleSpy).not.toHaveBeenCalled();
          expect(withoutTranscriptFields.sessions).toHaveLength(scenario.rows);
          for (const row of withoutTranscriptFields.sessions) {
            expect(row.derivedTitle).toBeUndefined();
            expect(row.lastMessagePreview).toBeUndefined();
          }
        } finally {
          projection?.dispose();
          titleSpy.mockRestore();
        }
      });
    },
  );
});
