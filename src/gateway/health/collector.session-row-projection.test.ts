import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readStatusSessionStores } from "../../status/session-stores.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { observeSessionRowBackfill } from "../session-row-backfill.test-support.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

afterEach(() => vi.restoreAllMocks());

async function settleProjection(projection: SessionRowProjection) {
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
}

describe("health and status resident session summaries", () => {
  it("counts a shared physical store once while retaining bounded per-agent windows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared-sessions.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, worker: {} },
          defaults: { systemAgent: { agentId: "main" } },
        },
        session: { store: storePath },
      };
      const agentIds = ["main", "worker"];
      const suffixes = Array.from({ length: 12 }, (_, index) => String(index).padStart(2, "0"));
      const sessionKeys = agentIds.flatMap((id) =>
        suffixes.map((suffix) => `agent:${id}:${suffix}`),
      );
      const backfill = observeSessionRowBackfill(sessionKeys);
      for (const agentId of agentIds) {
        for (const suffix of suffixes.toReversed()) {
          const key = `agent:${agentId}:${suffix}`;
          replaceSessionEntrySync(
            { agentId, sessionKey: key, storePath },
            { sessionId: key, updatedAt: agentId === "worker" ? 20 : 10 },
          );
        }
      }
      const projection = await createSessionRowProjection({ cfg });
      try {
        await settleProjection(projection);
        await backfill;
        await settleProjection(projection);
        const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
        const reads = observeMainThreadReads();
        const agents = agentIds.map((id) => ({ id }));
        for (const limit of [-2.5, 0, 0.5, 5, 5.7, 10, Infinity, Number.NaN]) {
          const status = await readStatusSessionStores(cfg, agents, limit, projection);
          expect(status.paths).toHaveLength(1);
          expect(status.count).toBe(24);
          expect(status.recent.map((row) => row.sessionKey)).toEqual(
            [...sessionKeys.slice(12), ...sessionKeys.slice(0, 12)].slice(0, limit),
          );
          expect(status.byAgent.map((agent) => [agent.agent.id, agent.count])).toEqual([
            ["main", 12],
            ["worker", 12],
          ]);
          for (const agent of status.byAgent) {
            expect(agent.recent.map((row) => row.sessionKey)).toEqual(
              suffixes.slice(0, limit).map((suffix) => `agent:${agent.agent.id}:${suffix}`),
            );
          }
        }
        for (const limit of [0, 5]) {
          const subset = await readStatusSessionStores(
            cfg,
            [{ id: "main" }, { id: "empty" }, { id: "main" }],
            limit,
            projection,
          );
          expect(subset.count).toBe(24);
          expect(subset.recent.map((row) => row.sessionKey)).toEqual(
            sessionKeys.slice(12, 12 + limit),
          );
          expect(
            subset.byAgent.map(({ agent, count, recent }) => [
              agent.id,
              count,
              recent.map((row) => row.sessionKey),
            ]),
          ).toEqual([
            ["main", 12, sessionKeys.slice(0, limit)],
            ["empty", 0, []],
            ["main", 12, sessionKeys.slice(0, limit)],
          ]);
        }
        const health = await buildHealthAgentSummaries(
          cfg,
          resolveHealthAgentOrder(cfg),
          projection,
        );
        expect(health.map((agent) => agent.agentId)).toEqual(agentIds);
        for (const agent of health) {
          expect(agent.sessions.count).toBe(12);
          expect(agent.sessions.recent.map((row) => row.key)).toEqual(
            suffixes.slice(0, 5).map((suffix) => `agent:${agent.agentId}:${suffix}`),
          );
        }
        expect(prepares).not.toHaveBeenCalled();
        reads.expectIdle();
      } finally {
        projection.dispose();
      }
    });
  });

  it("uses no SQLite for clean repeats and follows dirty and topology publications", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const mainKey = "agent:main:primary";
      const backfill = observeSessionRowBackfill([mainKey]);
      const committed = await upsertSessionEntryCore(
        { agentId: "main", sessionKey: mainKey },
        { sessionId: "main-primary", updatedAt: 10 },
      );
      assert(committed, "Expected the session write owner to return its committed row");
      const initialUpdatedAt = committed.updatedAt;
      const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
      try {
        await settleProjection(projection);
        await backfill;
        await settleProjection(projection);
        expect(
          projection.describe({
            agentId: "main",
            key: mainKey,
          })?.entry,
        ).toMatchObject({ sessionId: committed.sessionId, updatedAt: initialUpdatedAt });

        const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
        const reads = observeMainThreadReads();
        const agents = [{ id: "main" }];
        const readStatus = () => readStatusSessionStores(cfg, agents, 10, projection);
        const readHealth = () =>
          buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg), projection);

        const firstStatus = await readStatus();
        expect(firstStatus.byAgent[0]).toMatchObject({
          count: 1,
          recent: [
            expect.objectContaining({
              sessionKey: mainKey,
              entry: expect.objectContaining({ updatedAt: initialUpdatedAt }),
            }),
          ],
        });
        const firstHealth = await readHealth();
        expect(firstHealth[0]?.sessions).toMatchObject({
          count: 1,
          recent: [expect.objectContaining({ key: mainKey, updatedAt: initialUpdatedAt })],
        });
        await readStatus();
        await readHealth();
        expect(prepares).not.toHaveBeenCalled();
        reads.expectIdle();

        const dirtyBackfill = observeSessionRowBackfill([mainKey]);
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: mainKey },
          { sessionId: "main-primary", updatedAt: 20 },
        );
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        const dirty = await readStatus();
        expect(dirty.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(20);
        expect(prepares.mock.calls.length + reads.count()).toBeGreaterThan(0);
        await dirtyBackfill;
        await settleProjection(projection);

        prepares.mockClear();
        reads.clear();
        const clean = await readHealth();
        expect(clean[0]?.sessions.recent[0]?.updatedAt).toBe(20);
        expect(prepares).not.toHaveBeenCalled();
        reads.expectIdle();

        const workerKey = "agent:worker:primary";
        await upsertSessionEntryCore(
          { agentId: "worker", sessionKey: workerKey },
          { sessionId: "worker-primary", updatedAt: 30 },
        );
        cfg = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, worker: {} },
            defaults: { systemAgent: { agentId: "main" } },
          },
        };
        sessionChanges.emit({ all: true, scope: "config" });
        const topology = await buildHealthAgentSummaries(
          cfg,
          resolveHealthAgentOrder(cfg),
          projection,
        );
        expect(topology.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
          ["main", 1],
          ["worker", 1],
        ]);
        expect(topology[1]?.sessions.recent[0]?.key).toBe(workerKey);
      } finally {
        projection.dispose();
      }
    });
  });
});
