/** Tests persisted navigation lineage independently of live subagent control. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { listSessionFixture } from "./session-list.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

describe("session list navigation lineage", () => {
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

  test.each(["recent", "idle", "fork", "visible spawn"] as const)(
    "keeps persistent dashboard navigation beyond run retention (%s)",
    async (kind) => {
      const storePath = path.join(tempDirs.make("session-navigation-retention-"), "sessions.json");
      const now = Date.UTC(2026, 8, 26, 12);
      const old = now - 2 * 60 * 60_000;
      const parentKey = "agent:main:dashboard:parent";
      const controllerKey = "agent:main:subagent:controller";
      const childKey = "agent:main:dashboard:child";
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const childEntry: SessionEntry = {
        sessionId: "child",
        updatedAt: kind === "recent" || kind === "fork" ? now - 1_000 : old,
        parentSessionKey: parentKey,
        parentSessionId: "parent",
        ...(kind === "fork"
          ? {
              status: "done",
              endedAt: old,
              forkSource: { sessionKey: parentKey, sessionId: "parent" },
            }
          : {}),
        ...(kind === "visible spawn" ? { spawnedBy: controllerKey, spawnDepth: 1 } : {}),
      };
      const store: Record<string, SessionEntry> = {
        [parentKey]: { sessionId: "parent", updatedAt: now },
        [controllerKey]: { sessionId: "controller", updatedAt: now },
        [childKey]: childEntry,
      };
      try {
        if (kind === "visible spawn") {
          addSubagentRunForTests({
            runId: "completed-visible-spawn",
            childSessionKey: childKey,
            requesterSessionKey: controllerKey,
            requesterDisplayKey: "controller",
            task: "persistent conversation",
            cleanup: "keep",
            createdAt: old - 2_000,
            startedAt: old - 1_000,
            endedAt: old,
            outcome: { status: "ok" },
          });
        }
        const list = (spawnedBy?: string) =>
          listSessionFixture({ cfg, storePath, store, opts: { spawnedBy } });
        const all = await list();
        expect(all.sessions.find((row) => row.key === childKey)?.parentSessionKey).toBe(parentKey);
        expect(all.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([
          childKey,
        ]);
        expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
        // Navigation persists; a completed delegation does not retain runtime ownership.
        expect(
          all.sessions.find((row) => row.key === controllerKey)?.childSessions,
        ).toBeUndefined();
        expect((await list(controllerKey)).sessions).toEqual([]);
        childEntry.archivedAt = now;
        expect((await list(parentKey)).sessions).toEqual([]);
        delete childEntry.archivedAt;
        expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  test("keeps persisted navigation lineage separate from live registry control", async () => {
    const storePath = path.join(tempDirs.make("session-navigation-lineage-"), "sessions.json");
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:controlled-child";
    const entry = {
      sessionId: "sess-controlled-child",
      updatedAt: now,
      spawnedBy: "agent:main:subagent:persisted-spawner",
      parentSessionKey: "agent:main:dashboard:navigation-parent",
      parentSessionId: "sess-navigation-parent",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: now - 10_000,
      forkSource: {
        sessionKey: "agent:main:main",
        sessionId: "sess-source",
        entryId: "entry-source",
      },
      previousSessionId: "sess-previous",
    } satisfies SessionEntry;

    addSubagentRunForTests({
      runId: "run-controlled-child",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:runtime-controller",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "controlled child",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
    });

    const result = await listSessionFixture({
      cfg,
      storePath,
      store: { [childSessionKey]: entry },
      opts: {},
    });
    const row = expectDefined(result.sessions[0], "controlled child row");

    expect(row.spawnedBy).toBe("agent:main:subagent:runtime-controller");
    expect(row.controlOwnerSessionKey).toBe("agent:main:subagent:runtime-controller");
    expect(row.parentSessionKey).toBe("agent:main:dashboard:navigation-parent");
    expect(row.parentSessionId).toBe("sess-navigation-parent");
    expect(row.createdVia).toBe("spawn");
    expect(row.createdActor).toEqual({
      type: "agent",
      id: "agent:main:main",
      identity: { type: "agent", id: "agent:main:main" },
    });
    expect(row.createdAt).toBe(now - 10_000);
    expect(row.forkSource).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "sess-source",
      entryId: "entry-source",
    });
    expect(row.previousSessionId).toBe("sess-previous");

    const homeLinkedResult = await listSessionFixture({
      cfg,
      storePath,
      store: {
        "agent:main:main": { sessionId: "sess-home", updatedAt: now - 1 },
        "agent:main:dashboard:conversation": {
          sessionId: "sess-conversation",
          updatedAt: now,
          parentSessionKey: "agent:main:main",
        },
      },
      opts: {},
    });
    const homeLinkedRow = expectDefined(
      homeLinkedResult.sessions.find(
        (session) => session.key === "agent:main:dashboard:conversation",
      ),
      "Home-linked conversation row",
    );
    expect(homeLinkedRow.parentSessionKey).toBe("agent:main:main");
    expect(homeLinkedRow.parentSessionId).toBeUndefined();
  });
});
