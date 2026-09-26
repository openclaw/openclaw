/**
 * Tests subagent session utility behavior and persisted session lookups.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as subagentRegistryState from "../agents/subagents/registry/subagent-registry-state.js";
import { canonicalSubagentRunFixtures } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunFixture } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
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
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createResidentSessionRowReader,
  createSessionRowProjectionFixture,
} from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
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
import {
  loadCombinedSessionStoreForGatewayCore,
  resolveGatewayModelSupportsImages,
} from "./session-utils.js";

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

  test("searches channel-derived display names before row enrichment", async () => {
    const result = await listSubagentSessions(
      {
        "agent:main:slack:group:general": {
          sessionId: "slack-general-session",
          updatedAt: 2,
          channel: "slack",
        } as SessionEntry,
        "agent:main:discord:group:random": {
          sessionId: "discord-random-session",
          updatedAt: 1,
          channel: "discord",
        } as SessionEntry,
      },
      { search: "slack:g-general" },
    );

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:slack:group:general",
    ]);
    expect(result.sessions[0]?.displayName).toBe("slack:g-general");
  });

  test("pages prepared rows without probing transcript files", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:newest": {
        sessionId: "newest-session",
        sessionFile: "/tmp/newest-session.jsonl",
        updatedAt: 300,
      } as SessionEntry,
      "agent:main:middle": {
        sessionId: "middle-session",
        sessionFile: "/tmp/middle-session.jsonl",
        updatedAt: 200,
      } as SessionEntry,
      "agent:main:oldest": {
        sessionId: "old-session",
        sessionFile: "/tmp/old-session.jsonl",
        updatedAt: 100,
      } as SessionEntry,
    };
    const projection = createSessionRowProjectionFixture({
      cfg,
      store,
      storePath: fixtureStorePath(),
    });
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const result = await listProjectedSessions({ projection, opts: { limit: 2 } });

      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        "newest-session",
        "middle-session",
      ]);
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      projection.dispose();
    }
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

  test("includes subagent status timing and direct child session keys", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:parent",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        updatedAt: now - 500,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      model: "openai/gpt-5.4",
    });
    claimAgentRunContext(
      "run-parent",
      { sessionKey: "agent:main:subagent:parent" },
      { trackOwner: true, ownsContext: true },
    );
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:child",
      controllerSessionKey: "agent:main:subagent:parent",
      createdAt: now - 8_000,
      startedAt: now - 7_500,
      endedAt: now - 2_500,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-failed",
      childSessionKey: "agent:main:subagent:failed",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 500,
      outcome: { status: "error", error: "boom" },
      model: "openai/gpt-5.4",
    });

    const result = await listSubagentSessions(store);

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9_000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7_500);
    expect(child?.endedAt).toBe(now - 2_500);
    expect(child?.runtimeMs).toBe(5_000);
    expect(child?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(child?.spawnedCwd).toBe("/tmp/task-repo");
    expect(child?.forkedFromParent).toBe(true);
    expect(child?.spawnDepth).toBe(2);
    expect(child?.subagentRole).toBe("orchestrator");
    expect(child?.subagentControlScope).toBe("children");
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5_000);
  });

  test("does not show stale registry-only subagent runs as actively running", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-display";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-display",
        updatedAt: now - 250,
        spawnedBy: "agent:main:main",
        status: "done",
        startedAt: now - 4_000,
        endedAt: now - 500,
        runtimeMs: 3_500,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-display",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "openai/gpt-5.4",
    });

    const result = await listSubagentSessions(store);

    const row = result.sessions.find((session) => session.key === childSessionKey);
    expect(row?.status).toBe("done");
    expect(row?.subagentRunState).toBe("historical");
    expect(row?.hasActiveSubagentRun).toBe(false);
    expect(row?.endedAt).toBe(now - 500);
    expect(row?.runtimeMs).toBe(3_500);
  });

  test("does not reattach moved children through stale spawnedBy store metadata", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-store": {
        sessionId: "sess-old-parent-store",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-store": {
        sessionId: "sess-new-parent-store",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-store": {
        sessionId: "sess-shared-child-store",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-store",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-store",
      childSessionKey: "agent:main:subagent:old-parent-store",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-store",
      childSessionKey: "agent:main:subagent:new-parent-store",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-store-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:old-parent-store",
      requesterSessionKey: "agent:main:subagent:old-parent-store",
      requesterDisplayKey: "old-parent-store",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-store-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:new-parent-store",
      requesterSessionKey: "agent:main:subagent:new-parent-store",
      requesterDisplayKey: "new-parent-store",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = await listSubagentSessions(store);

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent-store",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent-store",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child-store"]);
  });

  test("does not return moved child sessions from stale spawnedBy filters", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-filter": {
        sessionId: "sess-old-parent-filter",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-filter": {
        sessionId: "sess-new-parent-filter",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-filter": {
        sessionId: "sess-shared-child-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-filter",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-filter",
      childSessionKey: "agent:main:subagent:old-parent-filter",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-filter",
      childSessionKey: "agent:main:subagent:new-parent-filter",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-filter-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:old-parent-filter",
      requesterSessionKey: "agent:main:subagent:old-parent-filter",
      requesterDisplayKey: "old-parent-filter",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-filter-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:new-parent-filter",
      requesterSessionKey: "agent:main:subagent:new-parent-filter",
      requesterDisplayKey: "new-parent-filter",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = await listSubagentSessions(store, {
      spawnedBy: "agent:main:subagent:old-parent-filter",
    });

    expect(result.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("keeps the persisted parentSessionKey while reporting the newest runtime controller", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-parent";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-parent",
        updatedAt: now,
        parentSessionKey: "agent:main:subagent:old-parent-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-parent-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-parent",
      requesterSessionKey: "agent:main:subagent:old-parent-parent",
      requesterDisplayKey: "old-parent-parent",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-parent-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-parent",
      requesterSessionKey: "agent:main:subagent:new-parent-parent",
      requesterDisplayKey: "new-parent-parent",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = await listSubagentSessions(store);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe(childSessionKey);
    expect(result.sessions[0]?.parentSessionKey).toBe("agent:main:subagent:old-parent-parent");
    expect(result.sessions[0]?.spawnedBy).toBe("agent:main:subagent:new-parent-parent");
    expect(result.sessions[0]?.controlOwnerSessionKey).toBe(
      "agent:main:subagent:new-parent-parent",
    );
  });

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

  test.each([false, true])(
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

  test("does not keep old ended registry runs attached as child sessions", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-ended": {
        sessionId: "sess-old-ended",
        updatedAt: now - 60 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-ended",
      childSessionKey: "agent:main:subagent:old-ended",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });

    const all = await listSubagentSessions(store);
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = await listSubagentSessions(store, {
      spawnedBy: "agent:main:main",
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("keeps ended parents attached while live descendants are still running", async () => {
    const now = Date.now();
    const parentKey = "agent:main:subagent:ended-parent";
    const childKey = "agent:main:subagent:ended-parent:subagent:live-child";
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      [parentKey]: {
        sessionId: "sess-ended-parent",
        updatedAt: now - 31 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      [childKey]: {
        sessionId: "sess-live-child",
        updatedAt: now,
        spawnedBy: parentKey,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-ended-parent",
      childSessionKey: parentKey,
      controllerSessionKey: "agent:main:main",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-live-child",
      childSessionKey: childKey,
      controllerSessionKey: parentKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: "ended-parent",
      createdAt: now - 1_000,
      startedAt: now - 900,
    });

    const result = await listSubagentSessions(store);
    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([parentKey]);
    expect(main?.hasActiveSubagentRun).toBe(true);
    expect(result.sessions.find((session) => session.key === parentKey)?.hasActiveSubagentRun).toBe(
      true,
    );
  });

  test("falls back to persisted subagent timing after run archival", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:archived": {
        sessionId: "sess-archived",
        updatedAt: now,
        spawnedBy: "agent:main:main",
        startedAt: now - 20_000,
        endedAt: now - 5_000,
        runtimeMs: 15_000,
        status: "done",
      } as SessionEntry,
    };

    const result = await listSubagentSessions(store);

    const archived = result.sessions.find(
      (session) => session.key === "agent:main:subagent:archived",
    );
    expect(archived?.status).toBe("done");
    expect(archived?.startedAt).toBe(now - 20_000);
    expect(archived?.endedAt).toBe(now - 5_000);
    expect(archived?.runtimeMs).toBe(15_000);
  });

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

describe("loadCombinedSessionStoreForGatewayCore includes disk-only agents (#32804)", () => {
  test("fixed stores retain a colliding unsuffixed database on the default owner", async () => {
    await withStateDirEnv("openclaw-fixed-store-collision-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "ops.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: {
          entries: {
            main: { default: true },
            ops: {},
          },
        },
      } as OpenClawConfig;

      await seedSessionEntry(
        storePath,
        "main",
        { sessionId: "s-main-unscoped", updatedAt: 100 },
        "main",
      );

      const { diagnostics, store } = loadCombinedSessionStoreForGatewayCore(cfg);
      expect(store["agent:main:main"]?.sessionId).toBe("s-main-unscoped");
      expect(store["agent:ops:main"]).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.stringContaining(
          'owner "main" selected by database-registry; suffixed owner(s): "ops"',
        ),
      );
    });
  });

  test("fixed stores preserve a registered suffix while the default keeps the unsuffixed target", async () => {
    await withStateDirEnv("openclaw-fixed-store-registered-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "ops.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: {
          entries: {
            main: { default: true },
            ops: {},
          },
        },
      } as OpenClawConfig;

      await seedSessionEntry(
        storePath,
        "main",
        { sessionId: "s-ops-registered", updatedAt: 100 },
        "ops",
      );

      const { diagnostics, store } = loadCombinedSessionStoreForGatewayCore(cfg);
      expect(store["agent:ops:main"]?.sessionId).toBe("s-ops-registered");
      expect(store["agent:main:main"]).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.stringContaining(
          'owner "main" selected by configured-default; suffixed owner(s): "ops"',
        ),
      );
    });
  });

  test("fixed stores merge every configured agent's partition", async () => {
    await withStateDirEnv("openclaw-fixed-store-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared-sessions.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: {
          entries: {
            ops: { default: true },
            worker: {},
          },
        },
      } as OpenClawConfig;

      await seedSessionEntry(
        storePath,
        "agent:ops:main",
        { sessionId: "s-ops", updatedAt: 100 },
        "ops",
      );
      await seedSessionEntry(
        storePath,
        "agent:worker:main",
        { sessionId: "s-worker", updatedAt: 200 },
        "worker",
      );
      await seedSessionEntry(
        storePath,
        "agent:dynamic:main",
        { sessionId: "s-dynamic", updatedAt: 300 },
        "dynamic",
      );
      await seedSessionEntry(
        storePath,
        "agent:ops:legacy",
        { sessionId: "s-legacy-ops", spawnedBy: "agent:ops:main", updatedAt: 400 },
        "ops",
      );
      const dynamicIncognitoKey = "agent:dynamic:dashboard:incognito-child";
      await seedSessionEntry(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId: "dynamic" }),
        dynamicIncognitoKey,
        {
          incognito: true,
          parentSessionKey: "agent:ops:main",
          sessionId: "s-incognito-dynamic",
          updatedAt: 500,
        },
        "dynamic",
      );
      await seedSessionEntry(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId: "ops" }),
        "dashboard:incognito-ops",
        { incognito: true, sessionId: "s-incognito-ops", updatedAt: 600 },
        "ops",
      );

      const { store } = loadCombinedSessionStoreForGatewayCore(cfg);
      expect(store["agent:ops:main"]?.sessionId).toBe("s-ops");
      expect(store["agent:worker:main"]?.sessionId).toBe("s-worker");
      expect(store["agent:dynamic:main"]?.sessionId).toBe("s-dynamic");

      const configuredOnly = loadCombinedSessionStoreForGatewayCore(cfg, {
        configuredAgentsOnly: true,
      }).store;
      expect(configuredOnly["agent:ops:legacy"]?.sessionId).toBe("s-legacy-ops");
      expect(configuredOnly["agent:ops:legacy"]?.spawnedBy).toBe("agent:ops:main");
      expect(configuredOnly["agent:dynamic:main"]).toBeUndefined();
      expect(configuredOnly[dynamicIncognitoKey]?.sessionId).toBe("s-incognito-dynamic");

      const opsOnly = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "ops" }).store;
      expect(opsOnly["agent:ops:main"]?.sessionId).toBe("s-ops");
      expect(opsOnly["agent:ops:legacy"]?.sessionId).toBe("s-legacy-ops");
      expect(opsOnly["agent:worker:main"]).toBeUndefined();
      expect(opsOnly["agent:dynamic:main"]).toBeUndefined();

      const explicitDynamic = loadCombinedSessionStoreForGatewayCore(cfg, {
        agentId: "dynamic",
        configuredAgentsOnly: true,
      }).store;
      expect(explicitDynamic["agent:dynamic:main"]?.sessionId).toBe("s-dynamic");

      const mainOnly = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" }).store;
      expect(mainOnly["agent:ops:legacy"]).toBeUndefined();
    });
  });

  test("ACP agent sessions are visible even when agents.list is configured", async () => {
    await withStateDirEnv("openclaw-acp-vis-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      await seedSessionEntry(path.join(mainDir, "sessions.json"), "agent:main:main", {
        sessionId: "s-main",
        updatedAt: 100,
      });
      await seedSessionEntry(path.join(codexDir, "sessions.json"), "agent:codex:acp-task", {
        sessionId: "s-codex",
        updatedAt: 200,
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store } = loadCombinedSessionStoreForGatewayCore(cfg);
      expect(store["agent:main:main"]?.sessionId).toBe("s-main");
      expect(store["agent:codex:acp-task"]?.sessionId).toBe("s-codex");
    });
  });

  test("agent-scoped loads read only matching agent stores", async () => {
    await withStateDirEnv("openclaw-acp-scoped-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      const mainStorePath = path.join(mainDir, "sessions.json");
      const codexStorePath = path.join(codexDir, "sessions.json");
      await seedSessionEntry(mainStorePath, "agent:main:main", {
        sessionId: "s-main",
        updatedAt: 100,
      });
      await seedSessionEntry(codexStorePath, "agent:codex:acp-task", {
        sessionId: "s-codex",
        updatedAt: 200,
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store, storePath } = loadCombinedSessionStoreForGatewayCore(cfg, {
        agentId: "codex",
      });

      expect(path.resolve(storePath)).toBe(path.resolve(codexStorePath));
      expect(store["agent:codex:acp-task"]?.sessionId).toBe("s-codex");
      expect(store["agent:main:main"]).toBeUndefined();

      const mainOnly = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" }).store;
      expect(mainOnly["agent:main:main"]?.sessionId).toBe("s-main");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
