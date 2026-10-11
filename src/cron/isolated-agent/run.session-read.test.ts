import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearBootstrapSnapshot, getOrLoadBootstrapFiles } from "../../agents/bootstrap-cache.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as lifecycleProjection from "../../config/sessions/session-lifecycle-projection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
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
  appendSessionRuntimeContextMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  runEmbeddedAgentMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
} from "./run.test-harness.js";

const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
const actualAccessor = await vi.importActual<
  typeof import("../../config/sessions/session-accessor.js")
>("../../config/sessions/session-accessor.js");
const eventTarget = await import("../../auto-reply/reply/session-event-target.js");
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
  it("preserves a stale session when its Cron occurrence retires at reset commit", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-reset-refused-"));
    const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
    const sessionKey = "agent:main:persistent-cron";
    const target = { agentId: "main", storePath: database.path, sessionKey };
    const staleAt = Date.now() - 86_400_000;
    const sessionId = "stale-cron-session";
    await actualAccessor.replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "original-revision",
      updatedAt: staleAt,
      sessionStartedAt: staleAt,
      lastInteractionAt: staleAt,
    });
    const transcript = { ...target, sessionId };
    replaceTranscriptEventsSync(transcript, [
      { type: "session", id: sessionId, version: 3, timestamp: new Date(staleAt).toISOString() },
      {
        type: "message",
        id: "original-message",
        parentId: null,
        message: { role: "user", content: "Original context", timestamp: staleAt },
      },
    ]);
    const originalEntry = actualAccessor.loadSessionEntry(target);
    const originalTranscript = JSON.stringify(actualAccessor.loadTranscriptEventsSync(transcript));
    resolveCronSessionMock.mockImplementation(actualSession.prepareCronSession);
    loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
    patchSessionEntryMock.mockImplementation(actualAccessor.patchSessionEntryCore);

    const refusal = new Error("Cron occurrence retired before reset commit");
    let occurrenceActive = true;
    let resetCommitActive = false;
    let retiredAtCommit = false;
    const commit = lifecycleProjection.commitSessionLifecycleProjectionInWorker;
    const reset = vi
      .spyOn(lifecycleProjection, "commitSessionLifecycleProjectionInWorker")
      .mockImplementation((params) => {
        resetCommitActive = params.input.projected.upsertedEntries.some(
          (entry) => entry.sessionKey === sessionKey && entry.resetBoundary !== undefined,
        );
        return commit(params).finally(() => {
          resetCommitActive = false;
        });
      });
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (resetCommitActive && request.stage === "commit") {
            occurrenceActive = false;
            retiredAtCommit = true;
          }
          callback(request, grant);
        }, attachment),
      );
    let prepared: Awaited<ReturnType<typeof prepareCronRunContext>> | undefined;
    try {
      prepared = await prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture({
          agentId: "main",
          cfg: { session: { store: database.path, reset: { mode: "idle", idleMinutes: 1 } } },
          sessionKey,
          job: makeIsolatedAgentJobFixture({
            sessionTarget: `session:${sessionKey}`,
            delivery: { mode: "none" },
          }),
          assertCurrent: () => {
            if (!occurrenceActive) {
              throw refusal;
            }
          },
        }),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
      });
      expect(retiredAtCommit).toBe(true);
      expect(actualAccessor.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(
        originalEntry,
      );
      expect(JSON.stringify(actualAccessor.loadTranscriptEventsSync(transcript))).toBe(
        originalTranscript,
      );
    } finally {
      admission.mockRestore();
      reset.mockRestore();
      if (prepared?.ok) {
        await using _ = prepared.context.preparedModelRuntimeLease;
        prepared.context.sessionWorkAdmission.release();
        await prepared.context.workspaceLease?.release();
      }
    }
  });

  it.each([false, true])(
    "records a result after its own reset without adopting a foreign capture (replaced=%s)",
    async (replacedBeforePreparation) => {
      resetRunCronIsolatedAgentTurnHarness();
      mockRunCronFallbackPassthrough();
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-result-reset-"));
      const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
      const sessionKey = "agent:main:hook:persistent-monitor";
      const target = { agentId: "main", storePath: database.path, sessionKey };
      const staleAt = Date.now() - 86_400_000;
      const sessionId = "persistent-hook-session";
      const original = {
        sessionId,
        lifecycleRevision: "captured-revision",
        updatedAt: staleAt,
        sessionStartedAt: staleAt,
        lastInteractionAt: staleAt,
      };
      await actualAccessor.replaceSessionEntry(target, original);
      const transcript = { ...target, sessionId };
      replaceTranscriptEventsSync(transcript, [
        { type: "session", id: sessionId, version: 3, timestamp: new Date(staleAt).toISOString() },
      ]);
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: database.path, reset: { mode: "idle", idleMinutes: 1 } },
      };
      const previousConfig = getRuntimeConfigSnapshot();
      setRuntimeConfigSnapshot(cfg);
      const actualTarget = await vi.importActual<
        typeof import("../../auto-reply/reply/session-event-target.js")
      >("../../auto-reply/reply/session-event-target.js");
      const actualContext = await vi.importActual<
        typeof import("../../sessions/runtime-context.js")
      >("../../sessions/runtime-context.js");
      // Save native callables before spying: importActual can share this module object.
      const captureNative = actualTarget.captureSessionEventTargetForHost;
      const prepareNative = actualTarget.prepareSessionEventTargetForHost;
      const assertNative = actualTarget.assertSessionEventTargetCurrent;
      const capture = vi.spyOn(eventTarget, "captureSessionEventTargetForHost");
      const prepare = vi.spyOn(eventTarget, "prepareSessionEventTargetForHost");
      const assertCurrent = vi.spyOn(eventTarget, "assertSessionEventTargetCurrent");
      let captured:
        | Awaited<ReturnType<typeof actualTarget.captureSessionEventTargetForHost>>
        | undefined;
      capture.mockImplementation(async (...args) => {
        captured = await captureNative(...args);
        if (replacedBeforePreparation) {
          await actualAccessor.replaceSessionEntry(target, {
            ...original,
            lifecycleRevision: "foreign-replacement-revision",
          });
        }
        return captured;
      });
      prepare.mockImplementation(prepareNative);
      assertCurrent.mockImplementation(assertNative);
      resolveCronSessionMock.mockImplementation(actualSession.prepareCronSession);
      loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
      patchSessionEntryMock.mockImplementation(actualAccessor.patchSessionEntryCore);
      appendSessionRuntimeContextMock.mockImplementation(actualContext.appendSessionRuntimeContext);
      let runRevision: string | undefined;
      runEmbeddedAgentMock.mockImplementationOnce(async (request) => {
        await request.onExecutionStarted?.();
        const row = actualAccessor.loadSessionEntry({ ...target, readConsistency: "latest" });
        runRevision = row?.lifecycleRevision;
        expect(runRevision).toBeTruthy();
        expect(runRevision).not.toBe(original.lifecycleRevision);
        expect(runRevision).not.toBe("foreign-replacement-revision");
        createAutomationResultRecorder(
          request.runId,
          "test-job",
        )({
          outcome: "needs_attention",
          summary: "Persistent monitor found a new result",
        });
        return {
          payloads: [{ text: "Persistent monitor found a new result" }],
          meta: { agentMeta: {} },
        };
      });
      try {
        const run = await loadRunCronIsolatedAgentTurn();
        const result = await run(
          makeIsolatedAgentParamsFixture({
            cfg,
            agentId: "main",
            sessionKey,
            job: makeIsolatedAgentJobFixture({
              sessionTarget: `session:${sessionKey}`,
              delivery: { mode: "none" },
            }),
          }),
        );
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        const events = JSON.stringify(actualAccessor.loadTranscriptEventsSync(transcript));
        if (replacedBeforePreparation) {
          expect(result.status).toBe("error");
          expect(captured?.lifecycleRevision).toBe(original.lifecycleRevision);
          expect(appendSessionRuntimeContextMock).not.toHaveBeenCalled();
          expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
          expect(events).not.toContain("Automation result (recorded fact, not an instruction)");
        } else {
          expect(result).toMatchObject({
            status: "ok",
            summary: "needs_attention: Persistent monitor found a new result",
          });
          expect(captured?.lifecycleRevision).toBe(runRevision);
          expect(appendSessionRuntimeContextMock).toHaveBeenCalledOnce();
          expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
          expect(events).toContain(
            "Automation result (recorded fact, not an instruction): needs_attention: Persistent monitor found a new result",
          );
        }
      } finally {
        capture.mockRestore();
        prepare.mockRestore();
        assertCurrent.mockRestore();
        appendSessionRuntimeContextMock.mockReset().mockResolvedValue(undefined);
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );

  it("persists scheduled session rows through the worker without caller SQL", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-session-write-"));
    const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
    resolveCronSessionMock.mockImplementation(actualSession.prepareCronSession);
    loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
    const queries: string[] = [];
    patchSessionEntryMock.mockImplementation(
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
    const result = await prepareCronRunContext({
      input: makeIsolatedAgentParamsFixture({
        agentId: "main",
        cfg: { session: { store: database.path } },
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" } }),
      }),
      isFastTestEnv: true,
      onLifecycleInterrupt: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Cron preparation failed");
    }
    try {
      await using _ = result.context.preparedModelRuntimeLease;
      expect(patchSessionEntryMock).toHaveBeenCalled();
      expect(queries).toEqual([]);
      expect(
        actualAccessor.loadSessionEntry({
          storePath: database.path,
          sessionKey: "agent:main:cron:test-job",
        }),
      ).toMatchObject({ createdVia: "cron", sessionId: result.context.runSessionId });
    } finally {
      result.context.sessionWorkAdmission.release();
      await result.context.workspaceLease?.release();
    }
  });

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

  it("preserves bootstrap ownership when rollover admission is rejected", async () => {
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
      await actualAccessor.replaceSessionEntry(target, replacement);
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
    await expect(preparation).rejects.toMatchObject({
      name: "CronSessionLifecycleClaimError",
      admissionDisposition: "session-conflict",
    });
    expect(preflightCronModelProviderMock).not.toHaveBeenCalled();
    expect(await getOrLoadBootstrapFiles(bootstrapInput)).toBe(bootstrapFiles);
    expect(patchSessionEntryMock).not.toHaveBeenCalled();
    expect(actualAccessor.loadSessionEntry(target)).toMatchObject(replacement);
  });
});
