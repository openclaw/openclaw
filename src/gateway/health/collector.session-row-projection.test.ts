import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import * as heartbeatSummarySnapshot from "../../infra/heartbeat-summary-snapshot.js";
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

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settleProjection(projection: SessionRowProjection) {
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
}

describe("health agent summaries heartbeat roster", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("projects canonical automation policy for the fleet without re-walking the roster per agent", async () => {
    const agentCount = 200;
    const entries: Record<string, object> = {};
    for (let index = 0; index < agentCount; index += 1) {
      entries[`agent-${index}`] = {};
    }
    // An absent store isolates enrollment from session storage.
    const plain = {
      agents: {
        ownership: "explicit",
        entries,
      },
      session: {
        store: path.join(tempDirs.make("openclaw-health-heartbeat-roster-"), "sessions.json"),
      },
    } satisfies OpenClawConfig;
    let rosterReads = 0;
    const agents = new Proxy(plain.agents, {
      get(target, property, receiver) {
        if (property === "entries") {
          rosterReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const cfg = { ...plain, agents };
    const primaryJob = {
      id: "converted-heartbeat-agent-7",
      agentId: "agent-7",
      name: "Converted automation",
      createdAtMs: 0,
      updatedAtMs: 0,
      enabled: true,
      schedule: { kind: "every", everyMs: 2_700_000 },
      payload: { kind: "agentTurn", message: "Check the inbox" },
      sessionTarget: "main",
      wakeMode: "now",
      delivery: { mode: "announce", target: "owner" },
      state: {},
    } satisfies CronJob;
    const snapshot = vi
      .spyOn(heartbeatSummarySnapshot, "readHeartbeatSummarySnapshot")
      .mockResolvedValue([
        primaryJob,
        { ...primaryJob, id: "other-converted-job", enabled: false },
      ]);

    const summaries = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(plain));

    expect(summaries).toHaveLength(agentCount);
    // Per-agent resolution used to re-walk the whole roster for each summary.
    expect(rosterReads).toBeLessThan(agentCount);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(cfg);
    expect(
      summaries.filter((summary) => summary.heartbeat.enabled).map((summary) => summary.agentId),
    ).toEqual(["agent-7"]);
    for (const summary of summaries) {
      expect(summary.heartbeat).toMatchObject(
        summary.agentId === "agent-7"
          ? { enabled: true, everyMs: 2_700_000, prompt: "Check the inbox", target: "owner" }
          : { enabled: false, everyMs: null, prompt: "", target: "none" },
      );
    }
  });
});

describe("health and status resident session summaries", () => {
  it("returns current counts and recent entries while unrelated display work is held", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const storePath = path.join(stateDir, "health-selection.sqlite");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const first = "agent:main:first";
      const second = "agent:main:second";
      const added = "agent:main:added";
      const backfill = observeSessionRowBackfill([first, second]);
      for (const [key, updatedAt] of [
        [first, 10],
        [second, 20],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key, storePath },
          { sessionId: key, updatedAt },
        );
      }
      const projection = await createSessionRowProjection({ cfg });
      const release = createDeferred();
      const displayJoined = createDeferred();
      let held: Promise<void> | undefined;
      let health: ReturnType<typeof buildHealthAgentSummaries> | undefined;
      try {
        await settleProjection(projection);
        await backfill;
        await settleProjection(projection);
        held = projection.withSelectionPreparation(() => release.promise);
        sessionChanges.emit({ all: true, scope: "catalog" });
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: first, storePath },
          { sessionId: first, updatedAt: 30 },
        );
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: added, storePath },
          { sessionId: added, updatedAt: 40 },
        );
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        const ensureMaterialized = projection.ensureMaterialized;
        vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
          // Observe the real blocked join so the regression fails without a wall-clock race.
          displayJoined.resolve();
          return ensureMaterialized();
        });
        health = buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg), projection);
        const outcome = await withinTest(
          Promise.race([
            health.then((agents) => ({ kind: "summary", agents })),
            displayJoined.promise.then(() => ({ kind: "display-join" })),
          ]),
          signal,
        );
        expect(outcome).toMatchObject({
          kind: "summary",
          agents: [
            {
              agentId: "main",
              sessions: {
                count: 3,
                recent: [
                  { key: added, updatedAt: 40 },
                  { key: first, updatedAt: 30 },
                  { key: second, updatedAt: 20 },
                ],
              },
            },
          ],
        });
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
      } finally {
        release.resolve();
        await Promise.allSettled([held, health]);
        await settleProjection(projection);
        projection.dispose();
      }
    });
  });

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
        agents: { entries: { main: {} } },
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

        replaceSessionEntrySync(
          { agentId: "main", sessionKey: mainKey },
          { sessionId: "main-primary", updatedAt: 20 },
        );
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        const dirty = await readStatus();
        expect(dirty.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(20);
        expect(prepares.mock.calls.length + reads.count()).toBeGreaterThan(0);
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
