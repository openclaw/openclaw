import path from "node:path";
import { afterEach, beforeEach, expect, it as baseIt, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway-read.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../../cron/proactive-job.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareStatusSessionStores } from "../../status/session-stores.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePublisher } from "../server-chat-lifecycle-publication.js";
import { createSessionEventSubscriberRegistry } from "../server-chat-state.js";
import { drainSessionEventPublications } from "../session-event-prepared-row.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
});

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

function writeSession(agentId: string, key: string, updatedAt: number, storePath: string) {
  replaceSessionEntrySync({ agentId, sessionKey: key, storePath }, { sessionId: key, updatedAt });
}

function sessionSummary(count: number, ...entries: [key: string, updatedAt: number][]) {
  return { count, recent: entries.map(([key, updatedAt]) => ({ key, updatedAt })) };
}

function summarizeStatus(status: Awaited<ReturnType<typeof readStatusSessionStores>>) {
  const keys = (rows: typeof status.recent) => rows.map((row) => row.sessionKey);
  return {
    paths: status.paths.length,
    count: status.count,
    recent: keys(status.recent),
    byAgent: status.byAgent.map(({ agent, count, recent }) => [agent.id, count, keys(recent)]),
  };
}

function fleetConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  store?: string,
): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries, defaults: { systemAgent: { agentId: "main" } } },
    ...(store ? { session: { store } } : {}),
  };
}

it("projects receipt-owned jobs for the whole fleet without re-walking the roster per agent", async ({
  state,
}) => {
  const agentCount = 200;
  const entries = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, {}]),
  );
  const plain = {
    agents: { ownership: "explicit", entries },
    session: { store: state.statePath("health-sessions.sqlite") },
  } satisfies OpenClawConfig;
  const job = createDefaultProactiveJob(plain, "agent-7", 1, 45 * 60 * 1000);
  await saveProactiveJobsForTest(state.statePath("cron", "jobs.json"), [job]);
  let rosterReads = 0;
  const agents = new Proxy(plain.agents, {
    get(target, property, receiver) {
      if (property === "entries") {
        rosterReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const summaries = await buildHealthAgentSummaries(
    { ...plain, agents },
    resolveHealthAgentOrder(plain),
  );

  expect(summaries).toHaveLength(agentCount);
  expect(rosterReads).toBeLessThan(agentCount);
  expect(summaries.filter((summary) => summary.heartbeat.enabled)).toMatchObject([
    { agentId: "agent-7", heartbeat: { enabled: true, everyMs: 2_700_000, target: "owner" } },
  ]);
});
it.for(["before-read", "during-topology"])(
  "reads surviving health summaries when an unrelated agent closes %s",
  async (phase, { state }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, retiring: {} } } };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["main", "retiring"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    }
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const closing = createDeferred();
    const release = createDeferred();
    let closed: Promise<unknown> | undefined;
    let unregister: (() => void) | undefined;
    try {
      await settleProjection(projection);
      const retiringPath = resolveOpenClawAgentSqlitePath({ agentId: "retiring" });
      const startClosing = () => {
        beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "delete-retiring",
          agentDir: path.dirname(retiringPath),
          workspaceDir: state.statePath("workspace-retiring"),
          sessionsDir: state.statePath("agents", "retiring", "sessions"),
          deleteFiles: false,
        });
        unregister = registerOpenClawAgentDatabaseAsyncResource({
          agentId: "retiring",
          path: retiringPath,
          revoke: closing.resolve,
          close: () => release.promise,
        });
        closed = closeOpenClawAgentDatabaseByPathAsync(retiringPath, "retiring");
      };
      if (phase === "during-topology") {
        const prepare = combinedStore.prepareCombinedSessionStoreForGatewayAsync;
        vi.spyOn(
          combinedStore,
          "prepareCombinedSessionStoreForGatewayAsync",
        ).mockImplementationOnce(async (...args) => {
          const captured = await prepare(...args);
          startClosing();
          await closing.promise;
          return captured;
        });
        sessionChanges.emit({ all: true, scope: "stores" });
      } else {
        startClosing();
        await closing.promise;
      }
      const summaries = await readHealth(cfg, projection);
      expect(summaries.map(({ agentId, sessions }) => [agentId, sessions.count])).toEqual([
        ["main", 1],
      ]);
      expect(summaries[0]?.sessions.recent[0]?.key).toBe("agent:main:main");
      const subscribers = createSessionEventSubscriberRegistry();
      subscribers.subscribe("observer");
      const broadcast = vi.fn();
      const publisher = createSessionLifecyclePublisher({
        broadcastToConnIds: broadcast,
        sessionEventSubscribers: subscribers,
        getSessionRowProjection: () => projection,
        persistGatewaySessionLifecycleEventForEvent: async () => {},
        loadGatewaySessionLifecycleSnapshotForEvent: (key, options) => ({
          row:
            options?.sessionRows?.describe({ key, agentId: options.agentId ?? "main" })
              ?.materialized.row ?? null,
        }),
      });
      publisher.publish({
        phase: "end",
        sessionKey: "agent:main:main",
        agentId: "main",
        clientRunId: "survivor-run",
        event: {
          runId: "survivor-run",
          sessionId: "main-session",
          seq: 1,
          stream: "lifecycle",
          ts: 2,
          data: { phase: "end" },
        },
        persistence: Promise.resolve(),
        projection,
      });
      await Promise.resolve();
      await drainSessionEventPublications(projection);
      expect(broadcast).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          phase: "end",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        }),
        new Set(["observer"]),
        expect.any(Object),
      );
    } finally {
      release.resolve();
      await closed;
      unregister?.();
    }
  },
);

it("serves dirty summaries without display joins and clean repeats without SQL", async ({
  signal,
  state,
}) => {
  const storePath = state.statePath("health-selection.sqlite");
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };
  setRuntimeConfigSnapshot(cfg);
  const first = "agent:main:first";
  const second = "agent:main:second";
  const added = "agent:main:added";
  writeSession("main", first, 10, storePath);
  writeSession("main", second, 20, storePath);
  using projection = await createTestProjection({ cfg });
  const release = createDeferred();
  const displayJoined = createDeferred();
  let held: Promise<void> | undefined;
  let health: ReturnType<typeof buildHealthAgentSummaries> | undefined;
  try {
    await settleProjection(projection);
    writeSession("main", first, 25, storePath);
    expect(projection.dirtyRowCount).toBeGreaterThan(0);
    const dirtyStatus = await readStatusSessionStores(cfg, [{ id: "main" }], 10, { projection });
    expect(dirtyStatus.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(25);
    await settleProjection(projection);
    held = projection.withSelectionPreparation(() => release.promise);
    sessionChanges.emit({ all: true, scope: "catalog" });
    writeSession("main", first, 30, storePath);
    writeSession("main", added, 40, storePath);
    expect(projection.dirtyRowCount).toBeGreaterThan(0);
    const ensureMaterialized = projection.ensureMaterialized;
    vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
      // Observe the real blocked join so the regression fails without a wall-clock race.
      displayJoined.resolve();
      return ensureMaterialized();
    });
    health = readHealth(cfg, projection);
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
          sessions: sessionSummary(3, [added, 40], [first, 30], [second, 20]),
        },
      ],
    });
    expect(projection.dirtyRowCount).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await Promise.allSettled([held, health]);
    await settleProjection(projection);
  }
  const sql = observeMainThreadSql();
  expect((await readHealth(cfg, projection))[0]?.sessions).toMatchObject(
    sessionSummary(3, [added, 40], [first, 30], [second, 20]),
  );
  await readHealth(cfg, projection);
  sql.expectIdle();
});

it("keeps shared-store counts and windows SQL-free after agent admission", async ({ state }) => {
  const storePath = state.statePath("shared-sessions.sqlite");
  let cfg = fleetConfig({ main: {} }, storePath);
  setRuntimeConfigSnapshot(cfg);
  const agentIds = ["main", "worker"];
  const suffixes = Array.from({ length: 12 }, (_, index) => String(index).padStart(2, "0"));
  const sessionKeys = agentIds.flatMap((id) => suffixes.map((suffix) => `agent:${id}:${suffix}`));
  for (const agentId of agentIds) {
    for (const suffix of suffixes.toReversed()) {
      const key = `agent:${agentId}:${suffix}`;
      writeSession(agentId, key, agentId === "worker" ? 20 : 10, storePath);
    }
  }
  using projection = await createTestProjection({ cfg, getConfig: () => cfg });
  await settleProjection(projection);
  expect((await readHealth(cfg, projection)).map(({ agentId }) => agentId)).toEqual(["main"]);
  cfg = fleetConfig({ main: {}, worker: {} }, storePath);
  setRuntimeConfigSnapshot(cfg);
  sessionChanges.emit({ all: true, scope: "config" });
  await settleProjection(projection);
  const sql = observeMainThreadSql();
  const agents = agentIds.map((id) => ({ id }));
  for (const limit of [-2.5, 0, 0.5, 5, 5.7, 10, Infinity, Number.NaN]) {
    expect(
      summarizeStatus(await readStatusSessionStores(cfg, agents, limit, { projection })),
    ).toEqual({
      paths: 1,
      count: 24,
      recent: [...sessionKeys.slice(12), ...sessionKeys.slice(0, 12)].slice(0, limit),
      byAgent: agentIds.map((id) => [
        id,
        12,
        suffixes.slice(0, limit).map((s) => `agent:${id}:${s}`),
      ]),
    });
  }
  for (const limit of [0, 5]) {
    const subset = await readStatusSessionStores(
      cfg,
      [{ id: "main" }, { id: "empty" }, { id: "main" }],
      limit,
      { projection },
    );
    expect(summarizeStatus(subset)).toMatchObject({
      count: 24,
      recent: sessionKeys.slice(12, 12 + limit),
      byAgent: [
        ["main", 12, sessionKeys.slice(0, limit)],
        ["empty", 0, []],
        ["main", 12, sessionKeys.slice(0, limit)],
      ],
    });
  }
  const health = await readHealth(cfg, projection);
  expect(health.map((agent) => agent.agentId)).toEqual(agentIds);
  for (const agent of health) {
    expect(agent.sessions.count).toBe(12);
    expect(agent.sessions.recent.map((row) => row.key)).toEqual(
      suffixes.slice(0, 5).map((suffix) => `agent:${agent.agentId}:${suffix}`),
    );
  }
  sql.expectIdle();
});
