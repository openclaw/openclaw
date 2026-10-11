import { expect, it, onTestFinished, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import "../agents/subagents/registry/subagent-registry-maintenance.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as maintenanceReads from "../config/sessions/session-entry-read-maintenance.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { removeCronRunContinuationSessionIfIdle } from "./run-continuation-cleanup.js";
import {
  createCronMutationProbe,
  type CronMutationProbe,
} from "./session-lifecycle.worker.test-support.js";
import { sweepCronRunSessions } from "./session-reaper.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";

const mutation = vi.hoisted(() => ({ current: undefined as CronMutationProbe | undefined }));

type CleanupKind = "continuation" | "reaper";

async function withCronFixture(
  kind: CleanupKind,
  run: (fixture: Awaited<ReturnType<typeof seedCronFixture>>) => Promise<void>,
) {
  let probe: CronMutationProbe | undefined;
  const operation = withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const exactKey = `agent:main:cron:worker-${kind}:run:worker-${kind}-run`;
      const current = createCronMutationProbe(exactKey);
      probe = current;
      mutation.current = current;
      try {
        await run(await seedCronFixture(kind, current));
      } finally {
        current.release();
        mutation.current = undefined;
        clearSubagentRunsReadCacheForTest();
        resetReaperThrottle();
      }
    },
  );
  onTestFinished(async () => {
    probe?.release();
    await operation.catch(() => {});
  });
  await operation;
}

async function seedCronFixture(kind: CleanupKind, probe: CronMutationProbe) {
  const now = Date.now();
  const base = { agentId: "main", sessionKey: `agent:main:cron:worker-${kind}` };
  const sessionId = `worker-${kind}-run`;
  const exact = { ...base, sessionKey: probe.sessionKey };
  const recent = { ...base, sessionKey: `${base.sessionKey}:run:recent` };
  const updatedAt = now - 25 * 3_600_000;
  await replaceSessionEntry(exact, {
    sessionId,
    updatedAt,
    cronRunContinuation: {
      lifecycleRevision: "worker-continuation",
      phase: "ready",
      basePersisted: true,
    },
  });
  await replaceSessionEntry(base, { sessionId, updatedAt });
  if (kind === "reaper") {
    await replaceSessionEntry(recent, { sessionId: "recent", updatedAt: now });
  }
  const events = [{ type: "session", id: sessionId, content: "Retained cron transcript" }];
  await replaceTranscriptEvents({ ...base, sessionId }, events);
  expect(loadSessionEntry(exact)?.updatedAt).toBe(updatedAt);
  const child = createSubagentRunRecord({
    runId: `settled-${kind}-child`,
    requesterSessionKey: exact.sessionKey,
    childSessionKey: `agent:main:subagent:${kind}-settled`,
    createdAt: now - 2_000,
    execution: { status: "terminal", endedAt: now - 1_000, outcome: { status: "ok" } },
    completion: { required: false },
    cleanupCompletedAt: now - 500,
    delivery: { status: "not_required" },
  });
  saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
  clearSubagentRunsReadCacheForTest();
  resetReaperThrottle();
  const context = captureOpenClawStateWorkerContext();
  const storePath = resolveDefaultSessionStorePath("main");
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const start = () => {
    const work =
      kind === "continuation"
        ? removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context)
        : sweepCronRunSessions({
            agentId: "main",
            sessionStorePath: storePath,
            cronConfig: { sessionRetention: "24h" },
            nowMs: now,
            log,
          });
    void work.catch(() => {});
    return work;
  };
  const verifyPreserved = async () => {
    expect(loadSessionEntry(base)).toMatchObject({ sessionId });
    expect(await loadTranscriptEvents({ ...base, sessionId })).toEqual(events);
    if (kind === "reaper") {
      expect(loadSessionEntry(recent)).toMatchObject({ sessionId: "recent", updatedAt: now });
    }
  };
  return { exact, log, start, verifyPreserved };
}

function holdInitialRead(kind: CleanupKind) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  mutation.current?.readerReleases.add(release.resolve);
  const originalEntry = sessionReads.withSessionEntryReadOnlyInWorker;
  const originalExpired = maintenanceReads.readExpiredCronRunEntriesInWorker;
  const read =
    kind === "continuation"
      ? vi
          .spyOn(sessionReads, "withSessionEntryReadOnlyInWorker")
          .mockImplementationOnce((scope, assertCurrent, consume) =>
            originalEntry(scope, assertCurrent, async (result, owner) => {
              expect(owner.kind).toBe("file");
              entered.resolve();
              await release.promise;
              return consume(result, owner);
            }),
          )
      : vi
          .spyOn(maintenanceReads, "readExpiredCronRunEntriesInWorker")
          .mockImplementationOnce(async (...args) => {
            const result = await originalExpired(...args);
            entered.resolve();
            await release.promise;
            return result;
          });
  return { entered: entered.promise, release: release.resolve, restore: () => read.mockRestore() };
}

it.each(["continuation", "reaper"] as const)(
  "refuses %s deletion after the captured default state source changes",
  async (kind) => {
    await withCronFixture(kind, async (fixture) => {
      const other = await createOpenClawTestState({ scenario: "minimal", applyEnv: false });
      const reader = holdInitialRead(kind);
      const work = fixture.start();
      try {
        expect(
          await Promise.race([reader.entered.then(() => "worker"), work.then(() => "done")]),
        ).toBe("worker");
        await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
          reader.release();
          if (kind === "continuation") {
            await expect(work).rejects.toThrow(/database changed during preparation/u);
          } else {
            expect(await work).toEqual({ swept: false, pruned: 0 });
            expect(fixture.log.warn).toHaveBeenCalledWith(
              expect.objectContaining({
                err: expect.stringMatching(/database changed during preparation/u),
              }),
              expect.any(String),
            );
          }
        });
        expect(loadSessionEntry(fixture.exact)).toBeDefined();
        await fixture.verifyPreserved();
      } finally {
        reader.release();
        await work.catch(() => {});
        reader.restore();
        await other.cleanup();
      }
    });
  },
);
