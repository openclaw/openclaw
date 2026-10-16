import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, test, expect, vi } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import * as modelCatalogLookup from "../agents/model-catalog-lookup.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayClient } from "./server-methods/types.js";
import * as projectionWork from "./session-projection-work.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { projectSessionPatchResult } from "./session-utils-model.js";
import * as rowProjection from "./session-utils-row.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

function prepareRuntime(cfg: OpenClawConfig) {
  resetPluginRuntimeStateForTest();
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot(cfg);
  return registry;
}

function makeStore(count: number, entry: (index: number) => [string, SessionEntry]) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => entry(index)));
}

function budgetStore(count: number) {
  return makeStore(count, (index) => [
    `agent:main:budget-${index}`,
    { sessionId: `budget-${index}`, updatedAt: index + 1 },
  ]);
}

function atImmediate(callback: () => void) {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      callback();
      resolve();
    });
  });
}

// Resolver call counts protect O(unique model tuples), without CI wall-clock noise.
describe("session list resolver cache", () => {
  test("bounds dirty-refresh roster work across config publication", async () => {
    const rosterSize = 32;
    await withStateDirEnv("openclaw-roster-chunks-", async () => {
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
      const observedEntries: typeof entries = {};
      // Getters preserve property-read accounting while keeping config snapshots cloneable.
      for (const id of Object.keys(entries)) {
        Object.defineProperty(observedEntries, id, {
          enumerable: true,
          get() {
            if (insideRow) {
              rowReads++;
            }
            return entries[id];
          },
        });
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: observedEntries,
          defaults: { model: { primary: "example/roster-model" }, thinkingDefault: "off" },
        },
      };
      prepareRuntime(cfg);
      const store = makeStore(rowCount, (index) => [
        `agent:${ownerId}:dashboard:${index}`,
        {
          sessionId: `row-chunk-${index}`,
          updatedAt: index + 1,
          createdActor: { type: "agent" as const, id: ownerId },
        },
      ]);
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
        projection = await createSessionRowProjection({ cfg });
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
                control = atImmediate(() => {
                  rowsBeforePause = projectedRows;
                  entries[ownerId] = {
                    identity: { name: "Refreshed owner" },
                    fastModeDefault: true,
                  };
                  setRuntimeConfigSnapshot(cfg);
                  identityDuringPause = resolveAgentIdentity(cfg, ownerId)?.name;
                });
              }
            }
          });
        try {
          writeResidentEntries(store, 1);
          await projection.ensureMaterialized();
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
  });

  test.each(["startup", "dirty refresh"])(
    "yields during expensive %s materialization without reprojecting unchanged rows",
    async (phase) => {
      await withStateDirEnv("openclaw-row-work-budget-", async () => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" } },
        };
        prepareRuntime(cfg);
        const rowCount = 96;
        const store = budgetStore(rowCount);
        writeResidentEntries(store);
        let projection: SessionRowProjection | undefined;
        if (phase === "dirty refresh") {
          projection = await createSessionRowProjection({ cfg });
        }
        let workMs = 0;
        let projectedRows = 0;
        let rowsAtControl = 0;
        let control: Promise<void> | undefined;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
        const readInputs = rowProjection.readSessionRowInputs;
        const rows = vi
          .spyOn(rowProjection, "readSessionRowInputs")
          .mockImplementation((params) => {
            const result = readInputs(params);
            workMs += 20;
            projectedRows++;
            if (projectedRows === 1) {
              control = atImmediate(() => {
                rowsAtControl = projectedRows;
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
          rows.mockClear();
          const result = await listProjectedSessions({ projection, opts: { limit: rowCount } });
          expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
          expect(rows).not.toHaveBeenCalled();
        } finally {
          rows.mockRestore();
          clock.mockRestore();
          await control;
          projection?.dispose();
        }
      });
    },
  );

  test("bounds catalog acquisition per publication and reuses each agent's model metadata", async () => {
    await withStateDirEnv("openclaw-perf-catalog-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {}, research: {} },
          defaults: { model: { primary: "example/model-hit" } },
        },
      };
      const pluginRegistry = prepareRuntime(cfg);
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
      const store = makeStore(80, (index) => {
        const agentId = index % 2 ? "research" : "main";
        return [
          `agent:${agentId}:dashboard:catalog-${index}`,
          {
            sessionId: `catalog-${index}`,
            updatedAt: index,
            providerOverride: "example",
            modelOverride:
              index % 8 < 2 ? "model-hit" : index % 8 < 4 ? "Model-Hit" : "model-missing",
          },
        ];
      });
      writeResidentEntries(store);
      const acpSessionKeys = new Set<string>();
      for (const [index, [sessionKey, entry]] of Object.entries(store).entries()) {
        if (index % 8 < 2) {
          acpSessionKeys.add(sessionKey);
          seedCanonicalAcpSessionMeta({
            sessionKey,
            sessionId: entry.sessionId,
            meta: {
              backend: "acpx",
              agent: index % 2 ? "research" : "main",
              runtimeSessionName: `catalog-${index}`,
              mode: "persistent",
              state: "idle",
              lastActivityAt: index,
            },
          });
        }
      }
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
              acpSessionKeys.has(row.key)
                ? undefined
                : revision *
                    (row.model === "Model-Hit" ? 2 : 1) *
                    (row.agentId === "main" ? 10_000 : 20_000),
            );
            expect(row).not.toHaveProperty("catalogEntry");
          }
          // Acquisition shares both hits and misses; defaults retain their separate lookup.
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(10);
          const inputs = vi.spyOn(rowProjection, "readSessionRowInputs");
          catalogSpy.mockClear();
          let warmCatalogReads: number;
          try {
            await listProjectedSessions({ projection, opts: { limit: 80 } });
            expect(inputs).not.toHaveBeenCalled();
            warmCatalogReads = catalogSpy.mock.calls.length;
          } finally {
            inputs.mockRestore();
          }
          catalogSpy.mockClear();
          const updatedKey = "agent:main:dashboard:catalog-2";
          for (let update = 0; update < 4; update++) {
            store[updatedKey] = { ...store[updatedKey]!, label: `Metadata update ${update}` };
            writeResidentEntries({ [updatedKey]: store[updatedKey]! }, 1);
            const updated = await listProjectedSessions({ projection, opts: { limit: 80 } });
            expect(updated.sessions.find((row) => row.key === updatedKey)).toMatchObject({
              label: `Metadata update ${update}`,
              contextTokens: revision * 20_000,
            });
          }
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(warmCatalogReads * 4);
          catalogSpy.mockClear();
          const key = "agent:main:dashboard:catalog-0";
          const patch = projectSessionPatchResult({
            cfg,
            canonicalKey: key,
            targetAgentId: "main",
            entry: store[key]!,
            preparedAcpMeta: projection.describe({ key, agentId: "main" })?.preparedAcpMeta ?? null,
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
    { name: "ordinary page", limit: 100, search: undefined },
    { name: "wide ordering", limit: 300, search: undefined },
    { name: "unmatched search", limit: 1, search: "unmatched" },
  ])(
    "reuses resident input facts for $name without a request-time yield",
    async ({ limit, search }) => {
      await withStateDirEnv("openclaw-list-work-budget-", async ({ stateDir }) => {
        const cfg: OpenClawConfig = {};
        prepareRuntime(cfg);
        const entryCount = limit === 300 ? 2051 : 32;
        const store = budgetStore(entryCount);
        const projection = createSessionRowProjectionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
        });
        // Measure resident row work independently of asynchronous identity-file admission.
        const identityRuntime = await import("../agents/identity-file-runtime.js");
        const identityReads = vi
          .spyOn(identityRuntime, "prepareIdentityFile")
          .mockResolvedValue({ kind: "missing" });
        let workMs = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
        const readInputs = rowProjection.readSessionRowInputs;
        const rows = vi
          .spyOn(rowProjection, "readSessionRowInputs")
          .mockImplementation((params) => {
            // The former acquisition charges must never be incurred by a clean request.
            workMs += 20;
            return readInputs(params);
          });
        let controlRan = false;
        const control = atImmediate(() => {
          controlRan = true;
        });
        try {
          for (let request = 0; request < 2; request++) {
            const result = await listProjectedSessions({
              projection,
              opts: { limit, search },
            });
            expect(result.sessions.map((row) => row.key)).toEqual(
              !search ? Object.keys(store).toReversed().slice(0, limit) : [],
            );
            expect(controlRan).toBe(false);
            expect(rows).not.toHaveBeenCalled();
            expect(workMs).toBe(0);
          }
        } finally {
          identityReads.mockRestore();
          rows.mockRestore();
          clock.mockRestore();
          projection.dispose();
          await control;
        }
      });
    },
  );

  test("bounds owner-first transcript fields without starving shared rows", async () => {
    const scenario = {
      count: 480,
      owned: 240,
      limit: 240,
      rows: 300,
      enriched: 160,
      sharedTail: 99,
    };
    await withStateDirEnv("openclaw-perf-title-batch-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
      };
      prepareRuntime(cfg);
      const storePath = path.join(stateDir, "sessions.json");
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      using _ = {
        [Symbol.dispose]: (await prepareUserProfileCatalog()).release,
      };
      const store = makeStore(scenario.count, (index) => {
        const sessionId = `title-batch-${index}`;
        const entry: SessionEntry = {
          sessionId,
          updatedAt: 1_000 - index,
          ...(index >= scenario.count - scenario.owned
            ? {
                createdVia: "operator",
                createdActor: { type: "human", source: "profile", id: ownerId },
              }
            : {}),
        };
        return [`agent:main:${sessionId}`, entry];
      });

      const titleFieldsBySessionKey = new Map(
        Array.from(
          { length: scenario.count },
          (_value, index) =>
            [
              `agent:main:title-batch-${index}`,
              { firstUserMessage: `title ${index}`, lastMessagePreview: `last ${index}` },
            ] as const,
        ),
      );
      let projection: ReturnType<typeof createSessionRowProjectionFixture> | undefined;
      const client: GatewayClient = {
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
      };
      prepareGatewayRecipientProfile(client);
      try {
        projection = createSessionRowProjectionFixture({
          cfg,
          storePath,
          store,
          titleFieldsBySessionKey,
        });
        const result = await listProjectedSessions({
          projection,
          client,
          opts: {
            ownerFirst: true,
            includeDerivedTitles: true,
            includeLastMessage: true,
            limit: scenario.limit,
          },
        });

        expect(result.sessions).toHaveLength(scenario.rows);
        expect(result.sessions.filter((row) => row.derivedTitle !== undefined)).toHaveLength(
          scenario.enriched,
        );
        expect(result.sessions.filter((row) => row.lastMessagePreview !== undefined)).toHaveLength(
          scenario.enriched,
        );
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
            ownerFirst: true,
            includeDerivedTitles: false,
            includeLastMessage: false,
            limit: scenario.limit,
          },
        });
        expect(withoutTranscriptFields.sessions).toHaveLength(scenario.rows);
        for (const row of withoutTranscriptFields.sessions) {
          expect(row.derivedTitle).toBeUndefined();
          expect(row.lastMessagePreview).toBeUndefined();
        }
      } finally {
        projection?.dispose();
      }
    });
  });
});
