import { setImmediate as nextTurn } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import {
  registerGeneratedMediaTaskActivity,
  clearGeneratedMediaTaskActivity,
} from "../agents/media-generation-activity.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import "../agents/subagents/registry/subagent-registry-maintenance.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.test-support.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { removeCronRunContinuationSessionIfIdle } from "./run-continuation-cleanup.js";
import {
  createCronMutationProbe,
  updateForeignSubagentPayload,
  withCronMutationProbe,
  type CronMutationProbe,
} from "./session-lifecycle.worker.test-support.js";
import { sweepCronRunSessions } from "./session-reaper.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";

const mutation = vi.hoisted(() => ({ current: undefined as CronMutationProbe | undefined }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const probe = mutation.current;
        const data: unknown = options?.workerData;
        const selected =
          probe &&
          filename.toString() === probe.moduleUrl &&
          data !== null &&
          typeof data === "object" &&
          "operation" in data &&
          data.operation === "reclaim";
        super(filename, selected ? withCronMutationProbe(options, probe) : options);
        if (selected) {
          this.on("message", (message: unknown) => {
            if (
              message &&
              typeof message === "object" &&
              "type" in message &&
              message.type === "cron-test:post-grant" &&
              "sessionKey" in message &&
              message.sessionKey === probe.sessionKey
            ) {
              probe.held = true;
              probe.checkpoint.resolve();
            }
          });
        }
      }
    },
  };
});
vi.mock(
  "../config/sessions/session-accessor.sqlite-reclamation-worker.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../config/sessions/session-accessor.sqlite-reclamation-worker.js")
      >();
    return {
      ...actual,
      withSqliteReclamationWorker: ((options, claim, run, assertCurrent, signal) =>
        actual.withSqliteReclamationWorker(
          options,
          claim,
          async (worker) => {
            const originalRun = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
              const probe = mutation.current;
              if (
                probe &&
                ["entry", "lifecycle-projection-commit"].includes(params.plan.kind) &&
                params.plan.descendantRunBasis?.sessionKeys.includes(probe.sessionKey)
              ) {
                probe.commitGate = params.commitGate;
              }
              return originalRun(params);
            });
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          assertCurrent,
          signal,
        )) satisfies typeof actual.withSqliteReclamationWorker,
    };
  },
);
vi.mock(
  "../config/sessions/session-accessor.sqlite-reclamation-commit.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../config/sessions/session-accessor.sqlite-reclamation-commit.js")
      >();
    return {
      ...actual,
      withSqliteReclamationAuthorization: ((buffer, database, assertCurrent, run) =>
        actual.withSqliteReclamationAuthorization(
          buffer,
          database,
          () => {
            const probe = mutation.current;
            if (probe?.commitGate === buffer) {
              probe.grantAttempts++;
              probe.beforeGrant?.();
            }
            assertCurrent();
          },
          run,
        )) satisfies typeof actual.withSqliteReclamationAuthorization,
    };
  },
);

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
  const unrelated = {
    ...child,
    runId: `unrelated-${kind}`,
    requesterSessionKey: "agent:main:other",
    childSessionKey: `agent:main:subagent:${kind}-other`,
  };
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
  return { kind, exact, child, unrelated, context, log, probe, start, verifyPreserved };
}

function holdInitialRead(kind: CleanupKind) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  mutation.current?.readerReleases.add(release.resolve);
  const originalEntry = sessionReads.withSessionEntryReadOnlyInWorker;
  const originalExpired = sessionReads.readExpiredCronRunEntriesInWorker;
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
          .spyOn(sessionReads, "readExpiredCronRunEntriesInWorker")
          .mockImplementationOnce(async (...args) => {
            const result = await originalExpired(...args);
            entered.resolve();
            await release.promise;
            return result;
          });
  return { entered: entered.promise, release: release.resolve, restore: () => read.mockRestore() };
}

async function expectRefusal(
  fixture: Awaited<ReturnType<typeof seedCronFixture>>,
  work: ReturnType<typeof fixture.start>,
  diagnostic: RegExp,
) {
  if (fixture.kind === "continuation") {
    await expect(work).rejects.toThrow(diagnostic);
  } else {
    expect(await work).toEqual({ swept: false, pruned: 0 });
    expect(fixture.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringMatching(diagnostic) }),
      expect.any(String),
    );
  }
  expect(loadSessionEntry(fixture.exact)).toBeDefined();
  await fixture.verifyPreserved();
}

async function assertCleanupOffHost(fixture: Awaited<ReturnType<typeof seedCronFixture>>) {
  const kind = fixture.kind;
  const reader = holdInitialRead(kind);
  const parent = observeParentSqlite();
  let settled = false;
  const outcome = fixture.start().finally(() => {
    settled = true;
  });
  void outcome.catch(() => {});
  let counts = emptySqliteCounts();
  try {
    expect(
      await Promise.race([reader.entered.then(() => "worker"), outcome.then(() => "done")]),
    ).toBe("worker");
    await nextTurn();
    expect(settled).toBe(false);
    reader.release();
    expect(
      await Promise.race([
        fixture.probe.checkpoint.promise.then(() => "grant"),
        outcome.then(() => "done"),
      ]),
    ).toBe("grant");
    expect(fixture.probe.grantAttempts).toBe(1);
    await nextTurn();
    expect(settled).toBe(false);
    fixture.probe.release();
    const result = await outcome;
    counts = { ...parent.counts };
    if (kind === "reaper") {
      expect(result).toEqual({ swept: true, pruned: 1 });
    }
    expect(fixture.log.warn).not.toHaveBeenCalled();
  } finally {
    reader.release();
    fixture.probe.release();
    await outcome.catch(() => {});
    parent.restore();
    reader.restore();
  }
  expect(loadSessionEntry(fixture.exact)).toBeUndefined();
  await fixture.verifyPreserved();
  expect(counts).toEqual(emptySqliteCounts());
}

it.each(["continuation", "reaper"] as const)(
  "retires an idle %s alias without host SQLite while preserving its base transcript",
  async (kind) => {
    await withCronFixture(kind, assertCleanupOffHost);
  },
);

it("retires a cold continuation alias without host SQLite while preserving its base transcript", async () => {
  await withCronFixture("continuation", async (fixture) => {
    await closeOpenClawAgentDatabasesAsync();
    await assertCleanupOffHost(fixture);
  });
});

it.each([
  ["continuation", "relevant"],
  ["continuation", "unrelated"],
  ["reaper", "relevant"],
  ["reaper", "unrelated"],
] as const)(
  "revalidates %s deletion after a %s foreign commit following the live grant",
  async (kind, change) => {
    await withCronFixture(kind, async (fixture) => {
      saveSubagentRegistryChangesToSqlite(new Map([[fixture.unrelated.runId, fixture.unrelated]]), [
        fixture.unrelated.runId,
      ]);
      clearSubagentRunsReadCacheForTest();
      let settled = false;
      const outcome = fixture.start().finally(() => {
        settled = true;
      });
      void outcome.catch(() => {});
      try {
        expect(
          await Promise.race([
            fixture.probe.checkpoint.promise.then(() => "grant"),
            outcome.then(() => "done"),
          ]),
        ).toBe("grant");
        expect(fixture.probe.grantAttempts).toBe(1);
        await nextTurn();
        expect(settled).toBe(false);
        const record =
          change === "relevant"
            ? {
                ...fixture.child,
                execution: { status: "running", startedAt: Date.now() },
                cleanupCompletedAt: undefined,
              }
            : { ...fixture.unrelated, task: "Foreign task text; maintenance protection unchanged" };
        await updateForeignSubagentPayload(
          fixture.context.admission.databasePath,
          record.runId,
          JSON.stringify(record),
        );
        fixture.probe.release();
        if (change === "relevant") {
          await expectRefusal(fixture, outcome, /Session subagent facts changed before commit/u);
        } else {
          const result = await outcome;
          if (kind === "reaper") {
            expect(result).toEqual({ swept: true, pruned: 1 });
          }
          expect(fixture.log.warn).not.toHaveBeenCalled();
          expect(loadSessionEntry(fixture.exact)).toBeUndefined();
          await fixture.verifyPreserved();
        }
      } finally {
        fixture.probe.release();
        await outcome.catch(() => {});
      }
    });
  },
);

it.each(["continuation", "reaper"] as const)(
  "refuses %s deletion when media becomes active at the live grant",
  async (kind) => {
    await withCronFixture(kind, async (fixture) => {
      const runId = `late-${kind}-media`;
      fixture.probe.beforeGrant = () =>
        registerGeneratedMediaTaskActivity(runId, fixture.exact.sessionKey, "main");
      const work = fixture.start();
      try {
        await expectRefusal(
          fixture,
          work,
          /unsettled background work|Cannot prune cron run continuation/u,
        );
        expect(fixture.probe.grantAttempts).toBe(1);
        expect(fixture.probe.held).toBe(false);
      } finally {
        fixture.probe.release();
        await work.catch(() => {});
        clearGeneratedMediaTaskActivity(runId);
      }
    });
  },
);

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
        expect(fixture.probe.grantAttempts).toBe(0);
        expect(loadSessionEntry(fixture.exact)).toBeDefined();
        await fixture.verifyPreserved();
      } finally {
        reader.release();
        fixture.probe.release();
        await work.catch(() => {});
        reader.restore();
        await other.cleanup();
      }
    });
  },
);
