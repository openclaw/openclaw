import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { clearCommandLane } from "../../process/command-queue.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { saveCronStore } from "../store.js";
import { enqueueRun } from "./ops-run.js";
import type { CronEvent } from "./state.js";
import { createCronServiceState } from "./state.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-transcript-lifecycle-",
});

it("runs a queued manual run outside the caller turn transcript lifecycle", async () => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
  clearCommandLane(CommandLane.Cron);
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-02-06T10:05:00.000Z");
  const job = createDueIsolatedJob({ id: "manual-from-agent-turn", nowMs: now, nextRunAtMs: now });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });

  const callerSessionKey = "agent:main:main";
  const callerTurnEnded = createDeferred();
  const finished = createDeferred<CronEvent>();
  const reportWrites: string[] = [];
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => {
      await callerTurnEnded.promise;
      await runWithOwnedSessionTranscriptWrite({ sessionKey: callerSessionKey }, () => {
        reportWrites.push("report");
      });
      return { status: "ok" as const };
    }),
    onEvent: (event) => {
      if (event.jobId === job.id && event.action === "finished") {
        finished.resolve(event);
      }
    },
  });
  const callerTurn = createEmbeddedAttemptTranscriptLifecycle({ runId: "caller-turn" });

  try {
    await withOwnedSessionTranscriptWrites(
      {
        sessionKey: callerSessionKey,
        withTranscriptWrite: (write) => callerTurn.withTranscriptWrite(write),
      },
      async () => {
        const result = await enqueueRun(state, job.id, "force");
        expect(result).toMatchObject({ ok: true, enqueued: true });
      },
    );
    await callerTurn.dispose();
    callerTurnEnded.resolve();

    await expect(finished.promise).resolves.toMatchObject({ status: "ok" });
    expect(reportWrites).toEqual(["report"]);
  } finally {
    callerTurnEnded.resolve();
    clearCommandLane(CommandLane.Cron);
    resetGatewayWorkAdmission();
  }
});
