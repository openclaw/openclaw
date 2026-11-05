import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import * as harness from "./run.test-harness.js";

const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
const actualAccessor = await vi.importActual<
  typeof import("../../config/sessions/session-accessor.js")
>("../../config/sessions/session-accessor.js");
const { prepareCronRunContext } = await import("./run-prepare.js");
const { beginCronPreparationEffect } = await import("./run-session-state.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
function openTestDatabase() {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-session-"));
  return openOpenClawAgentDatabase({ agentId: "main", env: process.env });
}
function prepareRun(storePath: string, sessionKey = "cron:test-job", job = {}) {
  return prepareCronRunContext({
    input: makeIsolatedAgentParamsFixture({
      agentId: "main",
      cfg: { session: { store: storePath } },
      sessionKey,
      job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" }, ...job }),
    }),
    isFastTestEnv: true,
    onLifecycleInterrupt: () => {},
  });
}

describe("cron session preparation", () => {
  beforeEach(harness.resetRunCronIsolatedAgentTurnHarness);
  it.each(["unchanged", "workspace"] as const)(
    "revalidates %s authority across absent-field snapshot representations",
    async (change) => {
      const database = openTestDatabase();
      const sessionKey = "agent:main:conversation";
      const target = { agentId: "main", storePath: database.path, sessionKey };
      const now = Date.now();
      const entry: SessionEntry = {
        sessionId: "creator-session",
        lifecycleRevision: "creator-revision",
        updatedAt: now,
        sessionStartedAt: now,
        createdActor: { type: "human", source: "profile", id: "creator" },
        spawnedCwd: "/tmp/creator-workspace",
      };
      await actualAccessor.replaceSessionEntry(target, entry);
      const cronSession = await actualSession.prepareCronSession({
        agentId: "main",
        cfg: { session: { store: database.path } },
        sessionKey,
        nowMs: now,
      });
      const initial = expectDefined(cronSession.initialSessionEntry, "initial session");
      const absent = { owner: undefined, participants: undefined, participantCount: undefined };
      expectObjectFields(initial, absent);
      delete initial.owner;
      delete initial.participants;
      delete initial.participantCount;
      if (change !== "unchanged") {
        await actualAccessor.replaceSessionEntry(target, {
          ...entry,
          spawnedCwd: "/tmp/another-workspace",
        });
      }
      harness.loadSessionEntryMock.mockImplementation(
        async (...args: Parameters<typeof actualSession.loadCronSessionEntryLatest>) => {
          const current = await actualSession.loadCronSessionEntryLatest(...args);
          // Published snapshots can include absent fields that SQL-backed rows omit.
          return (
            current && {
              ...current,
              owner: current.owner,
              participants: current.participants,
              participantCount: current.participantCount,
            }
          );
        },
      );
      const admission = beginCronPreparationEffect({
        agentId: "main",
        cronSession,
        agentSessionKey: sessionKey,
        runSessionKey: sessionKey,
        usesDetachedRunSession: false,
        onInterrupt: () => {},
      }).then((lease) => {
        try {
          return lease.isActive();
        } finally {
          lease.release();
        }
      });
      if (change === "unchanged") {
        await expect(admission).resolves.toBe(true);
      } else {
        await expect(admission).rejects.toMatchObject({
          name: "CronSessionLifecycleClaimError",
          admissionDisposition: "session-conflict",
        });
      }
    },
  );

  it("preserves a concurrent metadata write during detached preparation without caller SQL", async () => {
    const database = openTestDatabase();
    const target = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:cron:test-job",
    };
    await actualAccessor.replaceSessionEntry(target, {
      sessionId: "previous-run",
      lifecycleRevision: "previous-revision",
      updatedAt: Date.now(),
      createdVia: "cron",
      totalTokens: 10,
    });
    harness.resolveCronSessionMock.mockImplementation(async (params) => {
      const prepared = await actualSession.prepareCronSession(params);
      await actualAccessor.patchSessionEntryCore(target, () => ({ totalTokens: 25 }));
      return prepared;
    });
    harness.loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
    const queries: string[] = [];
    harness.patchSessionEntryMock.mockImplementation(
      async (...args: Parameters<typeof actualAccessor.patchSessionEntryCore>) => {
        const sql = observeHostDataSql();
        try {
          return await actualAccessor.patchSessionEntryCore(...args);
        } finally {
          queries.push(...sql.queries);
          sql.restore();
        }
      },
    );
    const result = await prepareRun(database.path);
    const context = expectDefined(result.ok ? result.context : undefined, "prepared context");
    try {
      await using _ = context.preparedModelRuntimeLease;
      expect(harness.patchSessionEntryMock).toHaveBeenCalled();
      expect(queries).toEqual([]);
      expect(actualAccessor.loadSessionEntry(target)).toMatchObject({
        createdVia: "cron",
        sessionId: context.runSessionId,
        totalTokens: 25,
      });
      expect(context.cronSession.sessionEntry.totalTokens).toBe(25);
    } finally {
      context.sessionPreparationEffect.release();
      await context.workspaceLease?.release();
    }
  });

  it("prepares full target and source rows without host database reads", async () => {
    const database = openTestDatabase();
    const scope = { agentId: "main", env: process.env };
    const targetKey = "agent:main:cron:test-job";
    const sourceKey = "agent:main:source";
    const now = Date.now();
    const target: SessionEntry = {
      sessionId: "target-session",
      lifecycleRevision: "target-revision",
      updatedAt: now,
      sessionStartedAt: now,
      createdVia: "cron",
      createdAt: now - 1_000,
      skillLibrarySelections: [
        {
          skillId: "00000000-0000-4000-8000-000000000001",
          revision: "a".repeat(64),
          name: "selected-skill",
          ownerProfileId: null,
        },
      ],
      skillsSnapshot: { prompt: "target prompt", skills: [] },
    };
    const source: SessionEntry = {
      sessionId: "source-session",
      lifecycleRevision: "source-revision",
      updatedAt: now,
      sessionStartedAt: now,
      label: "source label",
      thinkingLevel: "high",
      skillsSnapshot: { prompt: "source prompt", skills: [] },
    };
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, targetKey, target);
      writeSessionEntry(current, sourceKey, source);
      writeSessionEntry(current, "agent:main:unrelated", {
        sessionId: "unrelated-session",
        updatedAt: now,
        skillsSnapshot: { prompt: "unrelated prompt".repeat(128), skills: [] },
      });
    }, scope);

    let prepared: Awaited<ReturnType<typeof actualSession.prepareCronSession>> | undefined;
    const preparedBoundary = new Error("cron session preparation complete");
    harness.resolveCronSessionMock.mockImplementation(async (params) => {
      prepared = await actualSession.prepareCronSession(params);
      // Later lifecycle admission and writes have their own boundary coverage.
      throw preparedBoundary;
    });
    const host = observeHostDataSql();
    try {
      await expect(
        prepareRun(database.path, sourceKey, { sessionTarget: "current", sessionKey: sourceKey }),
      ).rejects.toBe(preparedBoundary);
      for (const calls of host.calls) {
        expect(calls).not.toHaveBeenCalled();
      }
    } finally {
      host.restore();
    }

    expect(Object.keys(prepared?.store ?? {}).toSorted()).toEqual(
      [targetKey, sourceKey].toSorted(),
    );
    expect(prepared).toMatchObject({
      initialSessionEntry: target,
      store: { [sourceKey]: source },
      sessionEntry: {
        label: source.label,
        thinkingLevel: source.thinkingLevel,
        createdAt: target.createdAt,
        createdVia: target.createdVia,
        skillLibrarySelections: target.skillLibrarySelections,
      },
      isNewSession: true,
    });
    expect(prepared?.sessionEntry.sessionId).not.toBe(source.sessionId);
  });
});
