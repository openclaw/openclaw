// Session utility performance tests protect resolver cache scaling for large
// session lists with repeated provider/model tuples.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, test, expect, vi } from "vitest";
import {
  readAcpSessionMetaBatch,
  readAcpSessionMetaForEntry,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import * as modelCatalogLookup from "../agents/model-catalog-lookup.js";
import * as sessionModelRef from "../agents/session-model-ref.js";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import * as usageFormat from "../utils/usage-format.js";
import { listSessionFixture, sessionStoreTargetsFixture } from "./session-list.test-support.js";
import * as titleReader from "./session-transcript-title-reader.js";
import { resolveEstimatedSessionCostUsd } from "./session-utils-core.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStoreAsync,
  type SessionListProjectionTiming,
} from "./session-utils-list.js";
import {
  projectSessionPatchResult,
  resolveGatewaySessionThinkingProjectionInternal,
} from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import * as rowProjection from "./session-utils-row.js";

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
          store,
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

  test("reuses roster facts within preparation chunks and refreshes them across a real yield", async () => {
    await withStateDirEnv("openclaw-roster-chunks-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      let rosterReads = 0;
      const agents = Array.from({ length: 30 }, (_, index) => ({
        identity: { name: `Agent ${index}` },
      }));
      const entries = Object.fromEntries(agents.map((entry, index) => [`agent-${index}`, entry]));
      agents.forEach((_, index) => {
        Object.defineProperty(entries, `agent-${index}`, {
          get: () => {
            rosterReads++;
            return agents[index]!;
          },
        });
      });
      const cfg: OpenClawConfig = { agents: { entries } };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      let workMs = 0;
      const store = Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `agent:agent-29:dashboard:${index}`,
          {
            sessionId: `chunk-${index}`,
            updatedAt: index + 1,
            get createdActor() {
              // Charge the real owner projection, after the roster index has been needed.
              workMs++;
              return { type: "agent" as const, id: index < 40 ? "agent-28" : "agent-29" };
            },
          },
        ]),
      );
      const storePath = path.join(stateDir, "sessions.json");
      const targetsBySessionKey = sessionStoreTargetsFixture({ cfg, store, storePath });
      const projectionTiming: SessionListProjectionTiming = {
        prepareSyncMs: 0,
        rowSyncMs: 0,
        yieldWaitMs: 0,
        yieldCount: 0,
      };
      const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
      const buildRow = rowProjection.buildGatewaySessionRow;
      let preparationReads: number | undefined;
      let preparationYields: number | undefined;
      const rows = vi
        .spyOn(rowProjection, "buildGatewaySessionRow")
        .mockImplementation((params) => {
          preparationReads ??= rosterReads;
          preparationYields ??= projectionTiming.yieldCount;
          return buildRow(params);
        });
      let identityDuringPause: string | undefined;
      let pauseProbeReads = 0;
      const control = new Promise<void>((resolve) => {
        setImmediate(() => {
          // Replace the whole entry: mutating a shared nested object could hide a leaked cache.
          agents[29] = { identity: { name: "Refreshed owner" } };
          const readsBeforeProbe = rosterReads;
          identityDuringPause = resolveAgentIdentity(cfg, "agent-29")?.name;
          pauseProbeReads = rosterReads - readsBeforeProbe;
          resolve();
        });
      });
      rosterReads = 0;
      try {
        const result = await listSessionsFromStoreAsync({
          cfg,
          store,
          storePath,
          targetsBySessionKey,
          workStartedAt: 0,
          projectionTiming,
          opts: { limit: 1 },
        });
        expect(identityDuringPause).toBe("Refreshed owner");
        expect(result.totalCount).toBe(80);
        expect(result.sessions.map((row) => row.key)).toEqual(["agent:agent-29:dashboard:79"]);
        // This owner is first encountered after the pause, so its facet proves preparation freshness.
        expect(result.owners?.find((owner) => owner.id === "agent-29")?.label).toBe(
          "Refreshed owner",
        );
        const yields = expectDefined(preparationYields, "row projection reached");
        expect(yields).toBeGreaterThan(0);
        const reads = expectDefined(preparationReads, "preparation reads recorded");
        expect(reads - pauseProbeReads).toBeLessThanOrEqual(agents.length * (yields + 4));
      } finally {
        rows.mockRestore();
        clock.mockRestore();
        await control;
      }
    });
  });

  test("bounds row roster lookups and refreshes them across a real row yield", async () => {
    await withStateDirEnv("openclaw-roster-row-chunks-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const rosterSize = 32;
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
      const storePath = path.join(stateDir, "sessions.json");
      const targetsBySessionKey = sessionStoreTargetsFixture({ cfg, store, storePath });
      const projectionTiming: SessionListProjectionTiming = {
        prepareSyncMs: 0,
        rowSyncMs: 0,
        yieldWaitMs: 0,
        yieldCount: 0,
      };
      let workMs = 0;
      let projectedRows = 0;
      let rowsBeforePause = 0;
      let identityDuringPause: string | undefined;
      let control: Promise<void> | undefined;
      const rowChunks = new Set<number>();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
      const buildRow = rowProjection.buildGatewaySessionRow;
      const rows = vi
        .spyOn(rowProjection, "buildGatewaySessionRow")
        .mockImplementation((params) => {
          rowChunks.add(projectionTiming.yieldCount);
          insideRow = true;
          try {
            return buildRow(params);
          } finally {
            insideRow = false;
            projectedRows++;
            workMs++;
            if (projectedRows === 1) {
              control = new Promise<void>((resolve) => {
                setImmediate(() => {
                  rowsBeforePause = projectedRows;
                  // Whole-entry replacement exposes facts incorrectly retained across await.
                  entries[ownerId] = {
                    identity: { name: "Refreshed owner" },
                    fastModeDefault: true,
                  };
                  identityDuringPause = resolveAgentIdentity(cfg, ownerId)?.name;
                  resolve();
                });
              });
            }
          }
        });
      try {
        const result = await listSessionsFromStoreAsync({
          cfg,
          store,
          storePath,
          targetsBySessionKey,
          projectionTiming,
          modelCatalog: [],
          opts: { limit: rowCount },
        });
        expect(result.count).toBe(rowCount);
        expect(result.totalCount).toBe(rowCount);
        expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
        expect(rowsBeforePause).toBeGreaterThan(0);
        expect(rowsBeforePause).toBeLessThan(rowCount);
        expect(identityDuringPause).toBe("Refreshed owner");
        expect(result.sessions.map((row) => row.effectiveFastMode)).toEqual(
          Array.from({ length: rowCount }, (_, index) => index >= rowsBeforePause),
        );
        expect(rowChunks.size).toBeGreaterThan(1);
        // Allow an entry index and both legacy-owner facts per real synchronous row chunk.
        // Preparation, target setup, and the outside-batch identity probe are not counted.
        expect(rowReads).toBeLessThanOrEqual(rosterSize * rowChunks.size * 3);
      } finally {
        rows.mockRestore();
        clock.mockRestore();
        await control;
      }
    });
  });

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
          filterAndSortSessionEntries({ cfg: selectionConfig, store, now: 2, opts: {} }),
        ).toEqual(Object.entries(store));
        expect(() =>
          filterAndSortSessionEntries({
            cfg: selectionConfig,
            store,
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
      await withStateDirEnv("openclaw-perf-default-model-", async ({ stateDir }) => {
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
        const resolver = vi.spyOn(sessionModelRef, "resolveSessionModelRefCore");
        try {
          const result = await listSessionFixture({
            cfg,
            store,
            storePath: path.join(stateDir, "sessions.json"),
            opts: { limit: 40, ...(search ? { search } : {}) },
          });
          expect(result.count).toBe(search ? 0 : 40);
          for (const row of result.sessions) {
            expect([row.modelProvider, row.model]).toEqual(
              row.agentId === "main" ? ["openai", "gpt-5"] : ["anthropic", "claude-sonnet-4-6"],
            );
          }
          expect(resolver).toHaveBeenCalledTimes(2);
        } finally {
          resolver.mockRestore();
        }
      });
    },
  );

  test("bounds catalog lookups per response while preserving each agent's model metadata", async () => {
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
      const catalogSpy = vi.spyOn(modelCatalogLookup, "findModelCatalogEntry");
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
          const result = await listSessionFixture({
            cfg,
            store,
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
            modelCatalog,
            opts: { limit: 80 },
          });
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
          // Hits and misses are shared within a response, including runtime/context projection.
          // Defaults can make a few additional lookups outside the row context.
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(10);
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
        catalogSpy.mockRestore();
      }
    });
  });

  test.each([
    {
      name: "cheap rows",
      shouldYield: false,
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
    "shares the event loop for $name",
    async ({
      rowWorkMs = 0,
      storeWorkMs = 0,
      preparationWorkMs = 0,
      orderingWorkMs = 0,
      metadataWorkMs = 0,
      search,
      keepRows = true,
      limit = 100,
      shouldYield = true,
    }) => {
      await withStateDirEnv("openclaw-list-work-budget-", async ({ stateDir }) => {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        const cfg: OpenClawConfig = {};
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot(cfg);
        let workMs = storeWorkMs;
        let orderingCalls = 0;
        let orderingCallsAtControl = 0;
        let orderingCallsBeforeRows: number | undefined;
        const metadataEntriesRead = new Set<number>();
        let metadataCallsAtControl = 0;
        const entryCount = orderingWorkMs > 0 ? 2051 : metadataWorkMs > 0 ? 600 : 32;
        const store = Object.fromEntries(
          Array.from({ length: entryCount }, (_, index) => [
            `agent:main:budget-${index}`,
            {
              sessionId: `budget-${index}`,
              updatedAt: index + 1,
              get acp() {
                metadataEntriesRead.add(index);
                workMs += metadataWorkMs;
                return undefined;
              },
              // Pin reads charge ordering work before any row is projected.
              get pinnedAt() {
                orderingCalls++;
                workMs += orderingWorkMs;
                return undefined;
              },
            },
          ]),
        );
        let controlBeforePreparation: boolean | undefined;
        let preparationCalls = 0;
        let preparationCallsAtControl = 0;
        const buildRow = rowProjection.buildGatewaySessionRow;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
        const rows = vi
          .spyOn(rowProjection, "buildGatewaySessionRow")
          .mockImplementation((params) => {
            orderingCallsBeforeRows ??= orderingCalls;
            const row = buildRow(params);
            workMs += rowWorkMs;
            return row;
          });
        let controlRan = false;
        const controlCallback = new Promise<void>((resolve) => {
          setImmediate(() => {
            controlRan = true;
            preparationCallsAtControl = preparationCalls;
            orderingCallsAtControl = orderingCalls;
            metadataCallsAtControl = metadataEntriesRead.size;
            resolve();
          });
        });
        try {
          const result = await listSessionFixture({
            cfg,
            workStartedAt: 0,
            storePath: path.join(stateDir, "sessions.json"),
            store,
            entryFilter: () => {
              controlBeforePreparation ??= controlRan;
              preparationCalls++;
              workMs += preparationWorkMs;
              return keepRows;
            },
            opts: { limit, search },
          });
          expect(result.sessions.map((row) => row.key)).toEqual(
            keepRows && !search ? Object.keys(store).toReversed().slice(0, limit) : [],
          );
          expect(controlRan).toBe(shouldYield);
          expect(controlBeforePreparation).toBe(false);
          if (preparationWorkMs > 0 && shouldYield) {
            expect(preparationCallsAtControl).toBeLessThan(preparationCalls);
          }
          if (orderingWorkMs > 0) {
            expect(orderingCallsAtControl).toBeLessThan(
              expectDefined(orderingCallsBeforeRows, "row projection started"),
            );
          }
          if (metadataWorkMs > 0) {
            expect(metadataCallsAtControl).toBeGreaterThan(0);
            expect(metadataCallsAtControl).toBeLessThan(entryCount);
          }
        } finally {
          rows.mockRestore();
          clock.mockRestore();
          await controlCallback;
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

  test("batches ACP metadata reads once per list without changing row results", async () => {
    await withStateDirEnv("openclaw-perf-acp-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5" },
            models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
            thinkingDefault: "off",
          },
        },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);

      const stateKey = "agent:default:webchat:dm:state";
      const missingKey = "agent:default:webchat:dm:missing";
      const markerKey = "agent:default:webchat:dm:marker";
      const stateEntry: SessionEntry = {
        sessionId: "state-session",
        updatedAt: 3,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const missingEntry: SessionEntry = {
        sessionId: "missing-session",
        updatedAt: 2,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const staleAliasEntry: SessionEntry = {
        sessionId: "stale-alias-session",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const markerMeta = {
        backend: "marker",
        agent: "marker-agent",
        runtimeSessionName: markerKey,
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 1,
      };
      const markerEntry: SessionEntry = {
        sessionId: "marker-session",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5",
        acp: markerMeta,
      };
      const stateMeta = {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: stateKey,
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 2,
      };
      writeAcpSessionMetaForMigration({
        sessionKey: stateKey,
        sessionId: stateEntry.sessionId,
        meta: stateMeta,
      });

      const perRowState = readAcpSessionMetaForEntry({ sessionKey: stateKey, entry: stateEntry });
      const perRowMissing = readAcpSessionMetaForEntry({
        sessionKey: missingKey,
        entry: missingEntry,
      });
      expect(
        readAcpSessionMetaBatch({
          entries: [
            { sessionKey: stateKey, entry: stateEntry },
            { sessionKey: stateKey, entry: staleAliasEntry },
            { sessionKey: missingKey, entry: missingEntry },
            { sessionKey: markerKey, entry: markerEntry },
          ],
        }),
      ).toEqual(
        new Map<SessionEntry, ReturnType<typeof readAcpSessionMetaForEntry>>([
          [markerEntry, markerMeta],
          [stateEntry, perRowState],
          [staleAliasEntry, undefined],
          [missingEntry, perRowMissing],
        ]),
      );

      const database = openOpenClawStateDatabase();
      const originalPrepare = database.db.prepare.bind(database.db);
      let acpSelects = 0;
      const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
        if (/^select\b.*\bacp_sessions\b/is.test(sql)) {
          acpSelects += 1;
        }
        return originalPrepare(sql);
      });
      try {
        // Composite and legacy identities share the production 500-key chunks.
        // Cross two boundaries without materializing tens of thousands of rows.
        const aboveBatchChunkSize = Array.from({ length: 501 }, (_, index) => ({
          sessionKey: `agent:default:webchat:dm:missing-${index}`,
          entry: {
            sessionId: `missing-session-${index}`,
            updatedAt: index,
          } satisfies SessionEntry,
        }));
        const chunkedBatch = readAcpSessionMetaBatch({ entries: aboveBatchChunkSize });
        expect(chunkedBatch.size).toBe(aboveBatchChunkSize.length);
        expect(chunkedBatch.get(aboveBatchChunkSize[0]!.entry)).toBeUndefined();
        expect(chunkedBatch.get(aboveBatchChunkSize.at(-1)!.entry)).toBeUndefined();
        expect(acpSelects).toBe(3);

        acpSelects = 0;
        const result = await listSessionFixture({
          cfg,
          storePath: path.join(stateDir, "agents", "default", "sessions", "sessions.json"),
          store: {
            [stateKey]: stateEntry,
            [missingKey]: missingEntry,
            [markerKey]: markerEntry,
          },
          opts: { limit: 3 },
        });
        expect(result.sessions).toHaveLength(3);
        expect(acpSelects).toBe(1);
        for (const search of ["openclaw", "unmatched-runtime"]) {
          acpSelects = 0;
          const rows = vi.spyOn(rowProjection, "buildGatewaySessionRow");
          try {
            const searched = await listSessionFixture({
              cfg,
              storePath: path.join(stateDir, "agents", "default", "sessions", "sessions.json"),
              store: Object.fromEntries(
                aboveBatchChunkSize
                  .slice(0, 55)
                  .map(({ sessionKey, entry }) => [sessionKey, entry]),
              ),
              opts: { search, limit: 1 },
            });
            expect(searched.totalCount).toBe(search === "openclaw" ? 55 : 0);
            expect(rows).toHaveBeenCalledTimes(searched.count);
            expect(acpSelects).toBe(1);
          } finally {
            rows.mockRestore();
          }
        }
      } finally {
        prepareSpy.mockRestore();
      }
    });
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
  ])("batches $name transcript hydration without starving shared rows", async (scenario) => {
    await withStateDirEnv("openclaw-perf-title-batch-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const storePath = "/tmp/sessions.json";
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

      const titleBatchSpy = vi
        .spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch")
        .mockImplementation((scopes) =>
          scopes.map((scope) => ({
            firstUserMessage: `title ${scope.sessionId.slice("title-batch-".length)}`,
            lastMessagePreview: `last ${scope.sessionId.slice("title-batch-".length)}`,
          })),
        );
      try {
        const result = await listSessionFixture({
          cfg,
          storePath,
          store,
          ownerFirstActorId: ownerId,
          opts: { includeDerivedTitles: true, includeLastMessage: true, limit: scenario.limit },
        });

        expect(result.sessions).toHaveLength(scenario.rows);
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy.mock.calls[0]?.[0]).toHaveLength(scenario.enriched);
        const sessionsByKey = new Map(result.sessions.map((session) => [session.key, session]));
        expect(sessionsByKey.get("agent:main:title-batch-0")).toMatchObject({
          derivedTitle: "Title 0",
          lastMessagePreview: "last 0",
        });
        expect(sessionsByKey.get(`agent:main:title-batch-${scenario.sharedTail}`)).toMatchObject({
          derivedTitle: `Title ${scenario.sharedTail}`,
          lastMessagePreview: `last ${scenario.sharedTail}`,
        });

        titleBatchSpy.mockClear();
        await listSessionFixture({
          cfg,
          storePath,
          store,
          ownerFirstActorId: ownerId,
          opts: { includeDerivedTitles: false, includeLastMessage: false, limit: scenario.limit },
        });
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy).toHaveBeenCalledWith([]);
      } finally {
        titleBatchSpy.mockRestore();
      }
    });
  });
});
