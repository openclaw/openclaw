import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { canonicalSubagentRunFixtures } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunFixture } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { registerSubagentSessionStatusTests } from "./session-utils.subagent-status.test-harness.js";
import { useSessionStoreFixture } from "./session-utils.test-support.js";
const rowReader = createResidentSessionRowReader();
async function withRegistry<T>(fn: () => Promise<T>, resetRuntimeConfig = false) {
  return withRawStateDirEnv("openclaw-session-subagent-", () =>
    withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      try {
        return await fn();
      } finally {
        await rowReader.dispose();
        if (resetRuntimeConfig) {
          resetConfigRuntimeState();
        }
        await closeOpenClawStateDatabaseAsync();
      }
    }),
  );
}

const fixtureStorePath = useSessionStoreFixture("openclaw-session-subagent-list-");

function childEntry(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return { sessionId, updatedAt, spawnedBy: "agent:main:main", ...overrides };
}

function runFixture(
  runId: string,
  childSessionKey: string,
  requesterSessionKey: string,
  createdAt: number,
  startedAt: number,
  overrides: Partial<SubagentRunFixture> = {},
): SubagentRunFixture {
  return {
    runId,
    childSessionKey,
    requesterSessionKey,
    createdAt,
    startedAt,
    requesterDisplayKey: "tree",
    task: "synthetic task",
    cleanup: "keep",
    ...overrides,
  };
}

describe("session list subagent metadata", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    await resetSubagentRegistryForTests({ persist: false });
    resetConfigRuntimeState();
  });
  beforeEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(cfg, cfg);
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { entries: { main: {} } },
  } satisfies OpenClawConfig;

  function listSubagentSessions(
    store: Record<string, SessionEntry>,
    opts: Parameters<typeof listSessionFixture>[0]["opts"] = {},
  ) {
    return listSessionFixture({ cfg, storePath: fixtureStorePath(), store, opts });
  }

  test("keeps exact rows equivalent through descendant retention, moves, generations, and deletion", async () => {
    await withRegistry(async () => {
      const now = Date.now();
      setRuntimeConfigSnapshot(cfg, cfg);
      const key = (name: string) => `agent:main:subagent:${name}`;
      const root = key("root");
      const movedRoot = key("moved-root");
      const navigation = key("navigation");
      const child = key("child");
      const grandchild = key("grandchild");
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      for (const sessionKey of [root, movedRoot, navigation, child, grandchild]) {
        await replaceSessionEntry(
          { storePath, sessionKey },
          {
            sessionId: sessionKey.split(":").at(-1)!,
            updatedAt: now,
            ...(sessionKey === child ? { spawnedBy: root, parentSessionKey: navigation } : {}),
          },
        );
      }
      const makeRun = (runId: string, childSessionKey: string, requesterSessionKey: string) =>
        runFixture(runId, childSessionKey, requesterSessionKey, now - 10_000, now - 9_000);
      const records: SubagentRunFixture[] = [
        {
          ...makeRun("child", child, key("other")),
          controllerSessionKey: root,
          endedAt: now - 3 * 60 * 60_000,
          outcome: { status: "ok" },
        },
        { ...makeRun("grandchild", grandchild, child), generation: 1 },
        makeRun("collision", key("old-collision"), root),
        {
          ...makeRun(" collision ", key("new-collision"), key("other")),
          createdAt: now - 5_000,
        },
        {
          ...makeRun("deleted-collector", key("deleted"), key("other")),
          controllerSessionKey: root,
          collect: true,
          groupId: "group",
          swarmRequesterSessionKey: root,
          requesterAgentId: "main",
          collectorCompletion: { status: "done" },
          endedAt: now - 1_000,
        },
      ];
      const runs = canonicalSubagentRunFixtures(new Map(records.map((run) => [run.runId, run])));
      saveSubagentRegistryToSqlite(runs);
      const read = async (sessionKey: string, at = now) =>
        expectDefined(await rowReader.row(sessionKey, { now: at }), "resident row");
      expect((await read(root)).childSessions).toEqual([child]);
      expect((await read(navigation)).childSessions).toEqual([child]);
      expect((await read(child)).hasActiveSubagentRun).toBe(true);
      expect((await read(root)).swarm?.groups).toMatchObject([{ groupId: "group", done: 1 }]);

      const moved = {
        ...expectDefined(runs.get("child"), "child run"),
        controllerSessionKey: movedRoot,
      };
      subagentRuns.set(moved.runId, moved);
      subagentRuns.commitOwnership(moved);
      expect((await read(root)).childSessions).toBeUndefined();
      expect((await read(movedRoot)).childSessions).toEqual([child]);
      expect((await read(navigation)).childSessions).toEqual([child]);

      const replacement = {
        ...expectDefined(runs.get("grandchild"), "grandchild run"),
        runId: "replacement",
        generation: 2,
        requesterSessionKey: key("unrelated"),
      };
      persistRegistryFixture(new Map([[replacement.runId, replacement]]), [replacement.runId]);
      expect((await read(child)).hasActiveSubagentRun).toBe(false);
      expect((await read(movedRoot)).childSessions).toBeUndefined();
      expect((await read(navigation)).childSessions).toBeUndefined();

      const recent = {
        ...moved,
        execution: { ...moved.execution, endedAt: now - 29 * 60_000 },
      };
      subagentRuns.set(recent.runId, recent);
      subagentRuns.commitOwnership(recent);
      expect((await read(movedRoot)).childSessions).toEqual([child]);
      expect((await read(movedRoot, now + 2 * 60_000)).childSessions).toBeUndefined();
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: child, storeKeys: [child] },
      });
      expect((await read(movedRoot)).childSessions).toBeUndefined();
      expect((await read(navigation)).childSessions).toBeUndefined();
    }, true);
  });

  registerSubagentSessionStatusTests(listSubagentSessions);

  test("uses the newest child-session row for stale/current replacement pairs", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store = { [childSessionKey]: childEntry("sess-stale-current", now) };

    await addSubagentRunForTests({
      runId: "run-stale-active",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5_000,
      startedAt: now - 4_500,
      model: "openai/gpt-5.4",
    });
    await addSubagentRunForTests({
      runId: "run-current-ended",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 1_000,
      startedAt: now - 900,
      endedAt: now - 200,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });

    const result = await listSubagentSessions(store);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      status: "done",
      startedAt: now - 900,
      endedAt: now - 200,
    });
  });

  test("keeps follow-up turn timing instead of the finished spawn run", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:follow-up";
    await addSubagentRunForTests({
      runId: "run-spawn",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 60_000,
      startedAt: now - 59_000,
      endedAt: now - 55_787,
      outcome: { status: "ok" },
    });
    const list = (entry: Partial<SessionEntry>) =>
      listSubagentSessions({
        [childSessionKey]: childEntry("sess-follow-up", now, entry),
      }).then((result) => result.sessions.find((session) => session.key === childSessionKey));

    // Lifecycle start cleared endedAt/runtimeMs for the follow-up turn.
    const running = await list({ startedAt: now - 30_000 });
    expect([running?.startedAt, running?.endedAt, running?.runtimeMs]).toEqual([
      now - 30_000,
      undefined,
      undefined,
    ]);

    const finished = await list({
      startedAt: now - 30_000,
      endedAt: now - 1_000,
      runtimeMs: 29_000,
      status: "done",
    });
    expect(finished).toMatchObject({ endedAt: now - 1_000, runtimeMs: 29_000 });
  });

  test("prefers persisted terminal session state when only stale active subagent snapshots remain", async () => {
    await withRegistry(async () => {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const records = [
        runFixture("run-complete", childSessionKey, "agent:main:main", now - 2_000, now - 1_900, {
          endedAt: now - 1_800,
          outcome: { status: "ok" },
        }),
        runFixture("run-live", childSessionKey, "agent:main:main", now - 10_000, now - 9_000),
      ];
      saveSubagentRegistryToSqlite(
        canonicalSubagentRunFixtures(new Map(records.map((run) => [run.runId, run]))),
      );
      const result = await listSubagentSessions({
        [childSessionKey]: childEntry("sess-disk-live", now, {
          status: "done",
          endedAt: now - 1_800,
          runtimeMs: 100,
        }),
      });
      expect(result.sessions.find((session) => session.key === childSessionKey)).toMatchObject({
        status: "done",
        subagentRunState: "historical",
        hasActiveSubagentRun: false,
        startedAt: now - 9_000,
        endedAt: now - 1_800,
        runtimeMs: 100,
      });
    });
  });

  test("does not reattach stale terminal store-only child links", async () => {
    await resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      },
      "agent:claude:acp:done-child": childEntry("sess-done-child", staleAt, {
        status: "done",
        endedAt: staleAt,
      }),
    };

    const all = await listSubagentSessions(store);
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = await listSubagentSessions(store, {
      spawnedBy: "agent:main:main",
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("omits deleted child sessions while retaining collector runs", async () => {
    const now = Date.now();
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:deleted";
    const store: Record<string, SessionEntry> = {
      [parentKey]: { sessionId: "parent", updatedAt: now },
      [childKey]: { sessionId: "child", updatedAt: now - 1 },
    };
    await addSubagentRunForTests({
      runId: "retained-child",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: "parent",
      cleanup: "delete",
      collect: true,
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
      cleanupCompletedAt: now - 500,
    });
    const list = (spawnedBy?: string) => listSubagentSessions(store, { spawnedBy });
    const before = await list();
    expect(before.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([childKey]);
    expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);

    delete store[childKey];
    const after = await list();
    expect((await list(parentKey)).sessions).toEqual([]);
    expect(after.sessions.find((row) => row.key === parentKey)?.childSessions).toBeUndefined();
  });
});
