import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearBootstrapSnapshot, getOrLoadBootstrapFiles } from "../../agents/bootstrap-cache.js";
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
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadSessionEntryMock,
  patchSessionEntryMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
} from "./run.test-harness.js";

const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
const actualAccessor = await vi.importActual<
  typeof import("../../config/sessions/session-accessor.js")
>("../../config/sessions/session-accessor.js");
const { prepareCronRunContext } = await import("./run-prepare.js");
const bootstrapSnapshots = new Set<string>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    for (const sessionKey of bootstrapSnapshots) {
      clearBootstrapSnapshot(sessionKey);
    }
    bootstrapSnapshots.clear();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

describe("cron session preparation", () => {
  it("prepares full target and source rows without host database reads", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-session-read-"));
    const scope = { agentId: "main", env: process.env };
    const database = openOpenClawAgentDatabase(scope);
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
    resolveCronSessionMock.mockImplementation(async (params) => {
      prepared = await actualSession.prepareCronSession(params);
      // Later lifecycle admission and writes have their own boundary coverage.
      throw preparedBoundary;
    });
    const host = observeHostDataSql();
    try {
      await expect(
        prepareCronRunContext({
          input: makeIsolatedAgentParamsFixture({
            agentId: "main",
            cfg: { session: { store: database.path } },
            sessionKey: sourceKey,
            job: makeIsolatedAgentJobFixture({
              sessionTarget: "current",
              sessionKey: sourceKey,
              delivery: { mode: "none" },
            }),
          }),
          isFastTestEnv: true,
          onLifecycleInterrupt: () => {},
        }),
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
    expect(prepared?.initialSessionEntry).toMatchObject(target);
    expect(prepared?.store[sourceKey]).toMatchObject(source);
    expect(prepared?.sessionEntry).toMatchObject({
      label: source.label,
      thinkingLevel: source.thinkingLevel,
      createdAt: target.createdAt,
      createdVia: target.createdVia,
      skillLibrarySelections: target.skillLibrarySelections,
    });
    expect(prepared?.isNewSession).toBe(true);
    expect(prepared?.sessionEntry.sessionId).not.toBe(source.sessionId);
  });

  it.each([
    { outcome: "rejected", replaceTarget: true },
    { outcome: "accepted", replaceTarget: false },
  ])(
    "preserves bootstrap ownership when rollover admission is $outcome",
    async ({ replaceTarget }) => {
      resetRunCronIsolatedAgentTurnHarness();
      const stateDir = tempDirs.make("openclaw-cron-session-read-rotation-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const scope = { agentId: "main", env: process.env };
      const database = openOpenClawAgentDatabase(scope);
      const sessionKey = "agent:main:cron:test-job";
      const target = { ...scope, storePath: database.path, sessionKey };
      const now = Date.now();
      const entry = {
        sessionId: "initial-session",
        lifecycleRevision: "initial-revision",
        updatedAt: now,
        sessionStartedAt: now,
      };
      await actualAccessor.replaceSessionEntry(target, entry);
      const bootstrapInput = { workspaceDir: stateDir, sessionKey };
      bootstrapSnapshots.add(sessionKey);
      const bootstrapFiles = await getOrLoadBootstrapFiles(bootstrapInput);
      const replacement = {
        ...entry,
        sessionId: "replacement-session",
        lifecycleRevision: "replacement-revision",
      };
      resolveCronSessionMock.mockImplementation(async (params) => {
        const prepared = await actualSession.prepareCronSession(params);
        if (replaceTarget) {
          await actualAccessor.replaceSessionEntry(target, replacement);
        }
        return prepared;
      });
      loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
      const admittedBoundary = new Error("cron lifecycle admission complete");
      preflightCronModelProviderMock.mockRejectedValue(admittedBoundary);

      const preparation = prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture({
          agentId: "main",
          cfg: { session: { store: database.path } },
          sessionKey,
          job: makeIsolatedAgentJobFixture({
            sessionTarget: "isolated",
            delivery: { mode: "none" },
          }),
        }),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
      });
      if (replaceTarget) {
        await expect(preparation).rejects.toMatchObject({
          name: "CronSessionLifecycleClaimError",
          admissionDisposition: "session-conflict",
        });
        expect(preflightCronModelProviderMock).not.toHaveBeenCalled();
        expect(await getOrLoadBootstrapFiles(bootstrapInput)).toBe(bootstrapFiles);
      } else {
        await expect(preparation).rejects.toBe(admittedBoundary);
        expect(await getOrLoadBootstrapFiles(bootstrapInput)).not.toBe(bootstrapFiles);
      }
      expect(patchSessionEntryMock).not.toHaveBeenCalled();
      expect(actualAccessor.loadSessionEntry(target)).toMatchObject(
        replaceTarget ? replacement : entry,
      );
    },
  );
});
