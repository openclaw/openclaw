import { afterEach, beforeEach, expect, it as baseIt, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../../cron/proactive-job.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { prepareStatusSessionStores } from "../../status/session-stores.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

const test = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
});

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  recordAgentDatabaseAdmissions([], { source: "startup" });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

function sessionConfig(store?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, worker: {} },
    },
    ...(store ? { session: { store } } : {}),
  };
}

function writeSession(agentId: string, key: string, updatedAt: number, storePath?: string) {
  replaceSessionEntrySync({ agentId, sessionKey: key, storePath }, { sessionId: key, updatedAt });
}

async function settleProjection(projection: SessionRowProjection) {
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
}

async function readStatusSessionStores(...args: Parameters<typeof prepareStatusSessionStores>) {
  return (await prepareStatusSessionStores(...args)).publish();
}

function readHealth(cfg: OpenClawConfig, projection: SessionRowProjection) {
  return buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg), projection);
}

test("reuses unchanged stores while refreshing heartbeat, age and changed rows", async ({
  state,
}) => {
  const cfg = sessionConfig();
  setRuntimeConfigSnapshot(cfg);
  writeSession("main", "agent:main:first", 100);
  writeSession("worker", "agent:worker:first", 50);
  const job = createDefaultProactiveJob(cfg, "main", 1, 60_000);
  const cronPath = state.statePath("cron", "jobs.json");
  await saveProactiveJobsForTest(cronPath, [job]);
  using projection = await createTestProjection({ cfg });
  await settleProjection(projection);
  const select = vi.spyOn(projection, "selectEntries");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  expect((await readHealth(cfg, projection))[0]).toMatchObject({
    heartbeat: { enabled: true, everyMs: 60_000 },
    sessions: { count: 1, recent: [{ key: "agent:main:first", age: 900 }] },
  });
  expect(select).toHaveBeenCalledTimes(2);

  for (const limit of [0, 5, 10, 0, 5, 10]) {
    const summary = await readStatusSessionStores(cfg, [{ id: "main" }], limit, { projection });
    expect(summary.count).toBe(1);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(
      limit ? ["agent:main:first"] : [],
    );
  }
  expect(select).toHaveBeenCalledTimes(2);

  job.schedule = { kind: "every", everyMs: 120_000, anchorMs: 1 };
  await saveProactiveJobsForTest(cronPath, [job]);
  now.mockReturnValue(2_000);
  expect((await readHealth(cfg, projection))[0]).toMatchObject({
    heartbeat: { enabled: true, everyMs: 120_000 },
    sessions: { count: 1, recent: [{ key: "agent:main:first", age: 1_900 }] },
  });
  expect(select).toHaveBeenCalledTimes(2);

  writeSession("main", "agent:main:second", 200);
  await settleProjection(projection);
  expect((await readHealth(cfg, projection))[0]?.sessions).toMatchObject({
    count: 2,
    recent: [
      { key: "agent:main:second", updatedAt: 200 },
      { key: "agent:main:first", updatedAt: 100 },
    ],
  });
  expect(select).toHaveBeenCalledTimes(2);

  sessionChanges.emit({ all: true, scope: "config" });
  await settleProjection(projection);
  select.mockClear().mockImplementationOnce(() => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  });
  expect((await readHealth(cfg, projection))[0]?.sessions.count).toBe(0);
  const current = await readHealth(cfg, projection);
  expect(current.map(({ sessions }) => sessions)).toMatchObject([
    {
      count: 2,
      recent: [
        { key: "agent:main:second", updatedAt: 200 },
        { key: "agent:main:first", updatedAt: 100 },
      ],
    },
    { count: 1, recent: [{ key: "agent:worker:first", updatedAt: 50 }] },
  ]);
  expect(select).toHaveBeenCalledTimes(3);
  await readHealth(cfg, projection);
  expect(select).toHaveBeenCalledTimes(3);
});

test("updates shared-store summary windows from row publications without rescanning", async ({
  state,
}) => {
  const storePath = state.statePath("shared-summary.sqlite");
  const cfg = sessionConfig(storePath);
  setRuntimeConfigSnapshot(cfg);
  const mainKey = (index: number) => `agent:main:${String(index).padStart(3, "0")}`;
  const workerKeys = Array.from({ length: 8 }, (_, index) => `agent:worker:${index}`);
  for (let index = 0; index < 248; index++) {
    writeSession("main", mainKey(index), index + 1, storePath);
  }
  for (const key of workerKeys) {
    writeSession("worker", key, 0, storePath);
  }
  using projection = await createTestProjection({ cfg, modelCatalog: [] });
  await settleProjection(projection);
  const select = vi.spyOn(projection, "selectEntries");
  const agents = [{ id: "main" }, { id: "worker" }];
  async function expectWindows(mainCount: number, mainKeys: string[]) {
    for (const limit of [0, 5, 10]) {
      const summary = await readStatusSessionStores(cfg, agents, limit, { projection });
      expect(summary.count).toBe(mainCount + 8);
      expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(mainKeys.slice(0, limit));
      expect(
        summary.byAgent.map(({ agent, count, recent }) => [
          agent.id,
          count,
          recent.map(({ sessionKey }) => sessionKey),
        ]),
      ).toEqual([
        ["main", mainCount, mainKeys.slice(0, limit)],
        ["worker", 8, workerKeys.slice(0, limit)],
      ]);
    }
    expect(
      (await readHealth(cfg, projection)).map(({ agentId, sessions }) => ({ agentId, sessions })),
    ).toMatchObject([
      {
        agentId: "main",
        sessions: { count: mainCount, recent: mainKeys.slice(0, 5).map((key) => ({ key })) },
      },
      {
        agentId: "worker",
        sessions: { count: 8, recent: workerKeys.slice(0, 5).map((key) => ({ key })) },
      },
    ]);
  }
  const initialKeys = Array.from({ length: 10 }, (_, index) => mainKey(247 - index));
  await expectWindows(248, initialKeys);
  const prepared = await prepareStatusSessionStores(cfg, agents, 10, { projection });
  select.mockClear();

  // Reverse insertion order distinguishes the key tie-breaker from publication order.
  for (let index = 255; index >= 248; index--) {
    writeSession("main", mainKey(index), 500, storePath);
  }
  await settleProjection(projection);
  const burstKeys = Array.from({ length: 8 }, (_, index) => mainKey(248 + index));
  await expectWindows(256, [...burstKeys, mainKey(247), mainKey(246)]);
  expect(select).not.toHaveBeenCalled();

  writeSession("main", mainKey(247), 900, storePath);
  await settleProjection(projection);
  await expectWindows(256, [mainKey(247), ...burstKeys, mainKey(246)]);
  writeSession("main", mainKey(247), 1, storePath);
  await settleProjection(projection);
  await expectWindows(256, [...burstKeys, mainKey(246), mainKey(245)]);
  expect(select).not.toHaveBeenCalled();

  const retained = prepared.publish();
  expect(retained.count).toBe(256);
  expect(retained.byAgent[0]?.count).toBe(248);
  expect(retained.byAgent[0]?.recent.map(({ sessionKey }) => sessionKey)).toEqual(initialKeys);
  expect(retained.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(248);
});
