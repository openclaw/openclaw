/**
 * Tests subagent session utility behavior and persisted session lookups.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as subagentRegistryState from "../agents/subagents/registry/subagent-registry-state.js";
import { canonicalSubagentRunFixtures } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunFixture } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.test-support.js";
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
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { useSessionStoreFixture } from "./session-utils.test-support.js";
const rowReader = createResidentSessionRowReader();
async function withStateDirEnv<T>(
  prefix: string,
  fn: (context: { tempRoot: string; stateDir: string }) => Promise<T>,
) {
  return withRawStateDirEnv(prefix, async (context) => {
    try {
      return await fn(context);
    } finally {
      await rowReader.dispose();
    }
  });
}
import { withEnvAsync } from "../test-utils/env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { resolveGatewayModelSupportsImages } from "./session-utils.js";
import { registerSubagentSessionStatusTests } from "./session-utils.subagent-status.test-harness.js";

const fixtureStorePath = useSessionStoreFixture("openclaw-session-subagent-list-");

async function seedSessionEntry(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
  agentId?: string,
): Promise<void> {
  await replaceSessionEntry({ ...(agentId ? { agentId } : {}), sessionKey, storePath }, entry);
}

describe("session list subagent metadata", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  function listSubagentSessions(
    store: Record<string, SessionEntry>,
    opts: Parameters<typeof listSessionFixture>[0]["opts"] = {},
  ) {
    return listSessionFixture({ cfg, storePath: fixtureStorePath(), store, opts });
  }

  test("keeps exact rows equivalent through descendant retention, moves, generations, and deletion", async () => {
    await withStateDirEnv("openclaw-exact-tree-parity-", async () => {
      await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
        const now = Date.now();
        const key = (name: string) => `agent:main:subagent:${name}`;
        const root = key("root");
        const movedRoot = key("moved-root");
        const navigation = key("navigation");
        const child = key("child");
        const grandchild = key("grandchild");
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        setRuntimeConfigSnapshot(cfg, cfg);
        try {
          for (const sessionKey of [root, movedRoot, navigation, child, grandchild]) {
            await seedSessionEntry(storePath, sessionKey, {
              sessionId: sessionKey.split(":").at(-1)!,
              updatedAt: now,
              ...(sessionKey === child ? { spawnedBy: root, parentSessionKey: navigation } : {}),
            });
          }
          const makeRun = (
            runId: string,
            childSessionKey: string,
            requesterSessionKey: string,
          ): SubagentRunFixture => ({
            runId,
            childSessionKey,
            requesterSessionKey,
            requesterDisplayKey: "tree",
            task: "synthetic task",
            cleanup: "keep",
            createdAt: now - 10_000,
            startedAt: now - 9_000,
          });
          const runs = canonicalSubagentRunFixtures(
            new Map([
              [
                "child",
                {
                  ...makeRun("child", child, key("other")),
                  controllerSessionKey: root,
                  endedAt: now - 3 * 60 * 60_000,
                  outcome: { status: "ok" },
                },
              ],
              ["grandchild", { ...makeRun("grandchild", grandchild, child), generation: 1 }],
              ["collision", makeRun("collision", key("old-collision"), root)],
              [
                " collision ",
                {
                  ...makeRun(" collision ", key("new-collision"), key("other")),
                  createdAt: now - 5_000,
                },
              ],
              [
                "deleted-collector",
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
              ],
            ]),
          );
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
          subagentRegistryState.persistSubagentRunsToDiskOrThrow(
            new Map([[replacement.runId, replacement]]),
            [replacement.runId],
          );
          expect((await read(child)).hasActiveSubagentRun).toBe(false);
          expect((await read(movedRoot)).childSessions).toBeUndefined();
          expect((await read(navigation)).childSessions).toBeUndefined();

          moved.execution.endedAt = now - 29 * 60_000;
          subagentRuns.commitOwnership(moved);
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
        } finally {
          await rowReader.dispose();
          resetConfigRuntimeState();
        }
      });
    });
  });

  test("discovers controlled children through both navigation and runtime owners", async () => {
    const now = Date.now();
    const navigationParentKey = "agent:main:dashboard:navigation-parent";
    const controlParentKey = "agent:main:subagent:runtime-controller";
    const staleParentKey = "agent:main:subagent:stale-controller";
    const childSessionKey = "agent:main:subagent:controlled-child";
    const store: Record<string, SessionEntry> = {
      [navigationParentKey]: {
        sessionId: "sess-navigation-parent",
        updatedAt: now - 2_000,
      } as SessionEntry,
      [controlParentKey]: {
        sessionId: "sess-runtime-controller",
        updatedAt: now - 1_000,
      } as SessionEntry,
      [childSessionKey]: {
        sessionId: "sess-controlled-child",
        updatedAt: now,
        spawnedBy: staleParentKey,
        parentSessionKey: navigationParentKey,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-controlled-child-dual-owner",
      childSessionKey,
      controllerSessionKey: controlParentKey,
      requesterSessionKey: controlParentKey,
      requesterDisplayKey: "runtime-controller",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
    });

    const listForOwner = async (ownerSessionKey: string) =>
      await listSubagentSessions(store, { spawnedBy: ownerSessionKey });

    const navigationChildren = (await listForOwner(navigationParentKey)).sessions;
    expect(navigationChildren.map((session) => session.key)).toEqual([childSessionKey]);
    expect(navigationChildren[0]?.parentSessionKey).toBe(navigationParentKey);
    expect(navigationChildren[0]?.controlOwnerSessionKey).toBe(controlParentKey);
    expect((await listForOwner(controlParentKey)).sessions.map((session) => session.key)).toEqual([
      childSessionKey,
    ]);
    expect((await listForOwner(staleParentKey)).sessions).toEqual([]);

    const all = await listSubagentSessions(store);
    expect(
      all.sessions.find((session) => session.key === navigationParentKey)?.childSessions,
    ).toEqual([childSessionKey]);
    expect(all.sessions.find((session) => session.key === controlParentKey)?.childSessions).toEqual(
      [childSessionKey],
    );
  });

  registerSubagentSessionStatusTests(listSubagentSessions);

  test("preserves original session timing across follow-up replacement runs", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:followup": {
        sessionId: "sess-followup",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-followup-new",
      childSessionKey: "agent:main:subagent:followup",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 30_000,
      sessionStartedAt: now - 150_000,
      accumulatedRuntimeMs: 120_000,
      model: "openai/gpt-5.4",
    });
    claimAgentRunContext(
      "run-followup-new",
      { sessionKey: "agent:main:subagent:followup" },
      { trackOwner: true, ownsContext: true },
    );

    const result = await listSubagentSessions(store);

    const followup = result.sessions.find(
      (session) => session.key === "agent:main:subagent:followup",
    );
    expect(followup?.status).toBe("running");
    expect(followup?.startedAt).toBe(now - 150_000);
    expect(followup?.runtimeMs).toBeGreaterThanOrEqual(150_000);
  });

  test("uses the newest child-session row for stale/current replacement pairs", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-current",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-active",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5_000,
      startedAt: now - 4_500,
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
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
    expect(result.sessions[0]?.key).toBe(childSessionKey);
    expect(result.sessions[0]?.status).toBe("done");
    expect(result.sessions[0]?.startedAt).toBe(now - 900);
    expect(result.sessions[0]?.endedAt).toBe(now - 200);
  });

  test("prefers persisted terminal session state when only stale active subagent snapshots remain", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const persistedRuns = new Map<string, SubagentRunFixture>([
        [
          "run-complete",
          {
            runId: "run-complete",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "finished too early",
            cleanup: "keep",
            createdAt: now - 2_000,
            startedAt: now - 1_900,
            endedAt: now - 1_800,
            outcome: { status: "ok" },
          },
        ],
        [
          "run-live",
          {
            runId: "run-live",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "still running",
            cleanup: "keep",
            createdAt: now - 10_000,
            startedAt: now - 9_000,
          },
        ],
      ]);

      const row = await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
        },
        async () => {
          saveSubagentRegistryToSqlite(canonicalSubagentRunFixtures(persistedRuns));
          const result = await listSubagentSessions({
            [childSessionKey]: {
              sessionId: "sess-disk-live",
              updatedAt: now,
              spawnedBy: "agent:main:main",
              status: "done",
              endedAt: now - 1_800,
              runtimeMs: 100,
            } as SessionEntry,
          });
          return result.sessions.find((session) => session.key === childSessionKey);
        },
      );

      expect(row?.status).toBe("done");
      expect(row?.subagentRunState).toBe("historical");
      expect(row?.hasActiveSubagentRun).toBe(false);
      expect(row?.startedAt).toBe(now - 9_000);
      expect(row?.endedAt).toBe(now - 1_800);
      expect(row?.runtimeMs).toBe(100);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not reattach stale terminal store-only child links", async () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:claude:acp:done-child": {
        sessionId: "sess-done-child",
        updatedAt: staleAt,
        spawnedBy: "agent:main:main",
        status: "done",
        endedAt: staleAt,
      } as SessionEntry,
    };

    const all = await listSubagentSessions(store);
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = await listSubagentSessions(store, {
      spawnedBy: "agent:main:main",
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("does not reattach stale orphan store-only child links without lifecycle fields", async () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:orphan": {
        sessionId: "sess-orphan",
        updatedAt: staleAt,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const all = await listSubagentSessions(store);
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = await listSubagentSessions(store, {
      spawnedBy: "agent:main:main",
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test.each([true])(
    "omits deleted child sessions while retaining runs (collector=%s)",
    async (collect) => {
      const now = Date.now();
      const parentKey = "agent:main:parent";
      const childKey = "agent:main:subagent:deleted";
      const store: Record<string, SessionEntry> = {
        [parentKey]: { sessionId: "parent", updatedAt: now },
        [childKey]: { sessionId: "child", updatedAt: now - 1 },
      };
      addSubagentRunForTests({
        runId: "retained-child",
        childSessionKey: childKey,
        requesterSessionKey: parentKey,
        requesterDisplayKey: "parent",
        cleanup: "delete",
        collect,
        createdAt: now - 5_000,
        startedAt: now - 4_000,
        endedAt: now - 1_000,
        outcome: { status: collect ? "ok" : "error" },
        cleanupCompletedAt: now - 500,
      });
      const list = (spawnedBy?: string) => listSubagentSessions(store, { spawnedBy });
      const before = await list();
      expect(before.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([
        childKey,
      ]);
      expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);

      // Session deletion must remove navigation without discarding the retained run/result.
      delete store[childKey];
      const after = await list();
      expect((await list(parentKey)).sessions).toEqual([]);
      expect(after.sessions.find((row) => row.key === parentKey)?.childSessions).toBeUndefined();
    },
  );

  test("maps timeout outcomes to timeout status and clamps negative runtime", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:timeout": {
        sessionId: "sess-timeout",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-timeout",
      childSessionKey: "agent:main:subagent:timeout",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 1_000,
      endedAt: now - 2_000,
      outcome: { status: "timeout" },
      model: "openai/gpt-5.4",
    });

    const result = await listSubagentSessions(store);

    const timeout = result.sessions.find(
      (session) => session.key === "agent:main:subagent:timeout",
    );
    expect(timeout?.status).toBe("timeout");
    expect(timeout?.runtimeMs).toBe(0);
  });

  test("fails closed when model lookup misses", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when model catalog load throws", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => {
          throw new Error("catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
  });
});
