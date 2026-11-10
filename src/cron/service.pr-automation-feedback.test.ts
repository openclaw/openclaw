// oxfmt-ignore
import {
  createFixture,
  agentResult,
  readObservation,
} from "./service.pr-automation.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { stateDir } from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runEmbeddedAgentMock } from "./isolated-agent/run.test-harness.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronStoreKey } from "./store/key.js";
import { maintainCronRunHistory } from "./store/run-history.js";
it("observes GitHub before a due autoFix model turn, even when the model does nothing", async () => {
  await using fixture = await createFixture("autoFix", true);
  runEmbeddedAgentMock.mockImplementation(async (params) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    expect(fixture.reads).toContain("graphql");
    expect(params.prompt).toContain(fixture.finding.body);
    return agentResult();
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  const event = await fixture.tick();
  expect(event?.error).toBeUndefined();
  expect(event).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  const observed = fixture.execution.getJob(fixture.selected.id)?.state.triggerState;
  expect(observed).toMatchObject({
    version: 3,
    blocked: expect.stringContaining("Awaiting verified"),
  });
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({
    enabled: true,
    state: {
      triggerState: expect.objectContaining({
        observed: asRecord(observed).dispatched,
        blocked: expect.stringContaining("unresolved"),
      }),
      nextRunAtMs: expect.any(Number),
    },
  });
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  // A native observation failure is not failure of the already-settled payload.
  // Keep the finding unresolved throughout recovery to expose accidental replay.
  fixture.failRead(true);
  expect(await fixture.tick()).toMatchObject({ status: "error" });
  fixture.failRead(false);
  for (let tick = 0; tick < 3; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  fixture.thread.isResolved = true;
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  const handled = fixture.execution.getJob(fixture.selected.id)?.state.triggerState;
  expect(
    handled,
    JSON.stringify(fixture.execution.getJob(fixture.selected.id)?.state),
  ).toMatchObject({
    disposition: { status: "blocked" },
  });
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toEqual(handled);
  fixture.failRead(true);
  expect(await fixture.tick()).toMatchObject({
    status: "error",
    error: expect.stringContaining("GitHub PR state is unavailable"),
  });
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toEqual(handled);
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(true);
  fixture.failRead(false);
  expect(await fixture.tick()).toBeUndefined();
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toEqual(handled);
});

it("observes edited feedback and CI reruns without replaying feedback for a new head", async () => {
  await using fixture = await createFixture(
    "autoFix",
    true,
    false,
    false,
    "Inspect only the selected PR under the existing task",
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  runEmbeddedAgentMock.mockImplementation(async (params) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return agentResult();
  });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  const initial = fixture.execution.getJob(fixture.selected.id)?.state.triggerState;
  fixture.finding.body = "Edited review: handle the real failure";
  fixture.finding.updatedAt = "2026-11-10T11:00:00Z";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).not.toEqual(initial);
  fixture.pr.head.sha = "c".repeat(40);
  fixture.graph.headRefOid = fixture.pr.head.sha;
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.oid = fixture.pr.head.sha;
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
    head: fixture.pr.head.sha,
  });
  fixture.thread.isResolved = true;
  // A bot-like spelling without repository association does not create work.
  fixture.graph.comments = fixture.connection([
    {
      ...fixture.finding,
      id: "own",
      authorAssociation: "NONE",
      author: { login: "publisher", __typename: "User", databaseId: undefined },
    },
    {
      ...fixture.finding,
      id: "untrusted",
      authorAssociation: "NONE",
      author: { login: "clawsweeper[bot]", __typename: "User", databaseId: undefined },
    },
  ]);
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  const check = {
    __typename: "CheckRun",
    id: "run-1",
    name: "unit",
    status: "COMPLETED",
    conclusion: "FAILURE",
    completedAt: "2026-11-10T10:00:00Z",
  };
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
    contexts: fixture.connection([check]),
  };
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
  check.id = "run-2";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(4);
  check.conclusion = "SUCCESS";
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(4);
  check.conclusion = "FAILURE";
  check.completedAt = "2026-11-10T11:00:00Z";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(5);
});

it("keeps unchanged failing CI quiet independently of successful unresolved feedback batches", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  const items = Array.from({ length: 4 }, (_, index) => ({
    ...fixture.finding,
    id: "comment-" + index,
  }));
  fixture.graph.comments = fixture.connection(items);
  const check = {
    __typename: "CheckRun",
    id: "run-1",
    name: "unit",
    status: "COMPLETED",
    conclusion: "FAILURE",
    completedAt: "2026-11-10T10:00:00Z",
  };
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
    contexts: fixture.connection([check]),
  };
  const seen: string[][] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      seen.push(readObservation(params.prompt).findings.map((f) => f.id));
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  for (let tick = 0; tick < 15; tick++) {
    await fixture.tick();
  }
  expect(seen).toEqual([
    items.slice(0, 3).map((f) => f.id),
    [expectDefined(items[3], "fourth finding").id],
  ]);
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
    dispositions: [],
    blocked: expect.stringContaining("unresolved"),
  });
  check.id = "run-2";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  for (let tick = 0; tick < 5; tick++) {
    await fixture.tick();
  }
  expect(seen).toEqual([
    items.slice(0, 3).map((f) => f.id),
    [expectDefined(items[3], "fourth finding").id],
    [],
  ]);
});

it("pauses before replacing an unobserved attempt whose native payload history expired", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  const items = Array.from({ length: 4 }, (_, index) => ({
    ...fixture.finding,
    id: "comment-" + index,
  }));
  fixture.graph.comments = fixture.connection(items);
  const seen: string[] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      seen.push(...readObservation(params.prompt).findings.map((f) => f.id));
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  const attempt = asRecord(
    fixture.execution.getJob(fixture.selected.id)?.state.triggerState,
  ).attempt;
  const attemptAtMs = asRecord(attempt).atMs;
  if (typeof attemptAtMs !== "number") {
    throw new Error("Missing observed attempt timestamp");
  }
  const readHistory = () =>
    readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(path.join(stateDir, "cron", "jobs.json")),
      jobId: fixture.selected.id,
      runId: `cron:${fixture.selected.id}:${attemptAtMs}`,
    }).entries;
  expect(readHistory()).toHaveLength(1);
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  fixture.advanceTime(8 * 24 * 60 * 60_000);
  const context = captureOpenClawStateWorkerContext();
  await maintainCronRunHistory(context, context.admission.assertCurrent);
  expect(readHistory()).toEqual([]);
  await fixture.execution.start();
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(seen).toEqual(items.slice(0, 3).map((f) => f.id));
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
    attempt,
    dispositions: [],
    blocked: expect.stringContaining("manual review"),
  });
});

it("persists consecutive thrown attempts and bounded cooldown before retrying unchanged feedback", async () => {
  await using fixture = await createFixture("autoFix");
  let phase = "provider";
  const revisions: string[] = [];
  runEmbeddedAgentMock.mockImplementation(async (params) => {
    if (phase === "provider") {
      throw new Error("Synthetic provider unavailable");
    }
    return await fixture.modelTools(params, async ({ automation }) => {
      revisions.push(
        expectDefined(readObservation(params.prompt).findings[0], "observed finding").revision,
      );
      await automation.execute("outcome", {
        action: "record_result",
        outcome: phase === "verify" ? "blocked" : "done",
        summary:
          phase === "verify"
            ? "Focused verification failed"
            : "Verified turn, native finding remains unresolved",
      });
      return agentResult();
    });
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  const attempts: number[] = [];
  let fingerprint: unknown;
  for (let retry = 0; retry < 4; retry++) {
    expect(await fixture.tick()).toMatchObject({
      status: "error",
      error: "Session event execution failed",
    });
    const state = asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState);
    const attempt = asRecord(state.attempt);
    expect(attempt.atMs).toEqual(expect.any(Number));
    expect(state.retries).toBe(retry);
    if (retry === 0) {
      fingerprint = attempt.fingerprint;
    }
    expect(attempt.fingerprint).toBe(fingerprint);
    if (typeof attempt.atMs !== "number") {
      throw new Error("Missing persisted payload attempt");
    }
    attempts.push(attempt.atMs);
    expect(
      readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(path.join(stateDir, "cron", "jobs.json")),
        jobId: fixture.selected.id,
        runId: "cron:" + fixture.selected.id + ":" + attempt.atMs,
      }).entries,
    ).toEqual([
      expect.objectContaining({
        runAtMs: attempt.atMs,
        triggerFired: true,
        status: "error",
      }),
    ]);
  }
  expect(new Set(attempts).size).toBe(4);
  expect(fixture.execution.getJob(fixture.selected.id)?.state).toMatchObject({
    consecutiveErrors: 4,
    lastRunStatus: "error",
    nextRunAtMs: expect.any(Number),
  });
  for (const phaseAfterCooldown of ["verify", "done"]) {
    for (let tick = 1; tick < 12; tick++) {
      expect(await fixture.tick()).toBeUndefined();
      expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
        retries: phaseAfterCooldown === "verify" ? 3 : 4,
        retryTicks: tick,
        blocked: expect.stringContaining("bounded retry cooldown"),
      });
    }
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(phaseAfterCooldown === "verify" ? 4 : 5);
    phase = phaseAfterCooldown;
    expect(await fixture.tick()).toMatchObject({
      status: "ok",
      result: { outcome: phase === "verify" ? "blocked" : "done" },
    });
    expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
      retries: phase === "verify" ? 4 : 5,
      retryTicks: 0,
      attempt: { fingerprint },
    });
  }
  expect(revisions).toHaveLength(2);
  expect(revisions[1]).toBe(revisions[0]);
  const calls = runEmbeddedAgentMock.mock.calls.length;
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(calls);
  expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({
    enabled: true,
    state: { triggerState: { disposition: { status: "blocked" } } },
  });
});

it.each(["ordinary", "replacement", "cancelled"])(
  "does not persist a failed %s trigger's proposed state",
  async (mode) => {
    await using fixture = await createFixture("autoFix");
    const previous = { retained: "before payload" };
    await fixture.execution.update(fixture.selected.id, {
      ...(mode === "ordinary"
        ? {
            trigger: { script: "return { fire: true, state: { obsolete: true } };" },
          }
        : {}),
      state: { triggerState: previous },
      enabled: true,
    });
    runEmbeddedAgentMock.mockImplementation(async () => {
      if (mode === "replacement") {
        await fixture.execution.update(fixture.selected.id, {
          trigger: { script: "return { fire: false };" },
          state: { triggerState: { replacement: "current owner" } },
        });
      } else if (mode === "cancelled") {
        await fixture.execution.update(fixture.selected.id, { enabled: false });
      }
      throw new Error("Synthetic payload failure");
    });
    expect(await fixture.tick()).toMatchObject({ status: "error" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({
      enabled: mode !== "cancelled",
      state: {
        triggerState: mode === "replacement" ? { replacement: "current owner" } : previous,
        lastRunStatus: "error",
      },
    });
    // Reload the native scheduler to check the durable commit, not just its cache.
    fixture.execution.stop();
    await fixture.execution.waitForIdle();
    await fixture.execution.start();
    expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toEqual(
      mode === "replacement" ? { replacement: "current owner" } : previous,
    );
  },
);

it("persists exact-revision non-actionable judgments without replaying non-thread praise", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  fixture.finding.body = "The error path now looks correct. Thanks!";
  fixture.graph.comments = fixture.connection([fixture.finding]);
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async ({ automation }) => {
      const observation = readObservation(params.prompt);
      const scratch = await automation.execute("scratch-read", { action: "scratch_get" });
      const currentRevision = asRecord(scratch.details).currentRevision;
      const finding = expectDefined(observation.findings[0], "observed finding");
      await automation.execute("judgment", {
        action: "scratch_set",
        expectedRevision: currentRevision,
        content: JSON.stringify({
          prAutoFix: {
            url: fixture.pr.html_url,
            head: observation.head,
            attempt: observation.fingerprint,
            findings: [
              {
                id: finding.id,
                revision: finding.revision,
                status: "not_actionable",
                reason:
                  "Reviewer confirms the already-correct error path; this revision requests no change",
                quote: fixture.finding.body,
              },
            ],
          },
        }),
      });
      await automation.execute("outcome", {
        action: "record_result",
        outcome: "done",
        summary: "Inspected the exact current praise revision",
      });
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(await fixture.tick()).toBeUndefined();
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
    dispositions: [
      expect.objectContaining({
        id: fixture.finding.id,
        status: "not_actionable",
        reason: expect.stringContaining("already-correct"),
        quote: fixture.finding.body,
      }),
    ],
    disposition: { status: "reviewed" },
  });
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  fixture.finding.body = "Correction: the timeout still fails";
  fixture.finding.updatedAt = "2026-11-10T15:00:00Z";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
});

it("keeps accumulated Unicode disposition evidence within Cron’s real 16KB state budget", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  const items = Array.from({ length: 24 }, (_, index) => ({
    ...fixture.finding,
    id: "praise-" + index,
    body: "Looks good " + "🦞".repeat(200),
  }));
  fixture.graph.comments = fixture.connection(items);
  const seen: string[] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async ({ automation }) => {
      const observation = readObservation(params.prompt);
      seen.push(...observation.findings.map((f) => f.id));
      const scratch = await automation.execute("read", { action: "scratch_get" });
      await automation.execute("write", {
        action: "scratch_set",
        expectedRevision: asRecord(scratch.details).currentRevision,
        content: JSON.stringify({
          prAutoFix: {
            url: fixture.pr.html_url,
            head: observation.head,
            attempt: observation.fingerprint,
            findings: observation.findings.map((f) => ({
              id: f.id,
              revision: f.revision,
              status: "not_actionable",
              reason: "🦞".repeat(240),
              quote: "🦞".repeat(200),
            })),
          },
        }),
      });
      await automation.execute("outcome", {
        action: "record_result",
        outcome: "done",
        summary: "Inspected current praise revisions",
      });
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  for (let tick = 0; tick < 9; tick++) {
    const event = await fixture.tick();
    if (event) {
      expect(event.status, event.error).toBe("ok");
    }
    const job = expectDefined(fixture.execution.getJob(fixture.selected.id), "operational job");
    expect(job.enabled).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(job.state.triggerState))).toBeLessThanOrEqual(
      14 * 1024,
    );
  }
  expect(seen).toEqual(items.map((item) => item.id));
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(8);
  const state = asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState);
  expect(state.dispositions).toHaveLength(24);
  expect(state.disposition).toMatchObject({ status: "reviewed" });
});

it("retains more than 128 exact Unicode no-op revisions across inventories and history expiry", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  const items = Array.from({ length: 132 }, (_, index) => ({
    ...fixture.finding,
    id: "🦞".repeat(20) + index,
    body: "Unresolved review " + index,
  }));
  fixture.graph.comments = fixture.connection(items);
  const seen: string[] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      seen.push(...readObservation(params.prompt).findings.map((f) => f.id));
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  for (let tick = 0; tick < 45; tick++) {
    const event = await fixture.tick();
    if (event) {
      expect(event.status, event.error).toBe("ok");
    }
    expect(
      Buffer.byteLength(
        JSON.stringify(fixture.execution.getJob(fixture.selected.id)?.state.triggerState),
      ),
    ).toBeLessThanOrEqual(14 * 1024);
  }
  expect(seen).toEqual(items.map((f) => f.id));
  // Receipt state survives scheduler reload beyond native run-history retention.
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  fixture.advanceTime(8 * 24 * 60 * 60_000);
  const context = captureOpenClawStateWorkerContext();
  await maintainCronRunHistory(context, context.admission.assertCurrent);
  expect(
    readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(path.join(stateDir, "cron", "jobs.json")),
      jobId: fixture.selected.id,
    }).entries,
  ).toEqual([]);
  await fixture.execution.start();
  // Successful no-op receipts suppress unchanged feedback, not claim resolution.
  for (let tick = 0; tick < 100; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(seen).toEqual(items.map((f) => f.id));
  expectDefined(items[0], "first finding").updatedAt = "2026-11-10T17:00:00Z";
  for (let tick = 0; tick < 45; tick++) {
    await fixture.tick();
  }
  expect(seen.slice(132)).toEqual([expectDefined(items[0], "first finding").id]);
});

it("pauses model work instead of replaying forgotten revisions when exact receipt state is full", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  fixture.graph.comments = fixture.connection(
    Array.from({ length: 320 }, (_, index) => ({
      ...fixture.finding,
      id: "feedback-" + index,
    })),
  );
  const seen: string[] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      seen.push(...readObservation(params.prompt).findings.map((f) => f.id));
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  let paused = false;
  for (let tick = 0; tick < 110; tick++) {
    const event = await fixture.tick();
    if (event) {
      expect(event.status, event.error).toBe("ok");
    }
    const state = asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(14 * 1024);
    if (String(state.blocked).includes("model work is paused")) {
      paused = true;
      break;
    }
  }
  expect(paused).toBe(true);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.length).toBeLessThan(320);
  expect(new Set(seen).size).toBe(seen.length);
  const calls = runEmbeddedAgentMock.mock.calls.length;
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  fixture.advanceTime(8 * 24 * 60 * 60_000);
  await fixture.execution.start();
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(calls);
  expect(
    asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).blocked,
  ).toContain("manual review, not resolved");
  fixture.pr.state = "closed";
  fixture.pr.merged = true;
  await fixture.tick();
  expect(fixture.execution.getJob(fixture.selected.id)).toBeUndefined();
  expect(fixture.execution.getJob(fixture.other.id)).toBeDefined();
});

it("admits only the verified selected PR human author outside repository associations", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  fixture.pr.user = { id: 700, login: "outside-author", type: "User" };
  fixture.finding.authorAssociation = "NONE";
  fixture.graph.comments = fixture.connection([fixture.finding]);
  // Same spelling with another stable ID is not the selected human.
  fixture.finding.author = { login: "outside-author", __typename: "User", databaseId: 701 };
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toBeUndefined();
  fixture.finding.author.login = "unrelated-contributor";
  expect(await fixture.tick()).toBeUndefined();
  fixture.finding.author.databaseId = undefined;
  fixture.finding.author.login = "outside-author";
  expect(await fixture.tick()).toBeUndefined();
  // A Bot cannot inherit the verified human exception, even with the same ID.
  fixture.finding.author = { login: "outside-author", __typename: "Bot", databaseId: 700 };
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  fixture.finding.author = { login: "renamed-outside-author", __typename: "User", databaseId: 700 };
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      expect(readObservation(params.prompt).findings).toEqual([
        expect.objectContaining({ id: fixture.finding.id, author: "renamed-outside-author" }),
      ]);
      return agentResult();
    }),
  );
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
});

it("admits a repository/head App bot while refusing spelling, identity and integration spoofs", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  fixture.finding.authorAssociation = "NONE";
  fixture.finding.author = { login: "roboclaw[bot]", __typename: "Bot", databaseId: 900 };
  fixture.graph.comments = fixture.connection([fixture.finding]);
  const check = {
    __typename: "CheckRun",
    id: "app-check",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    checkSuite: { app: { slug: "roboclaw" }, repository: { nameWithOwner: "unrelated/repo" } },
  };
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
    state: "SUCCESS",
    contexts: fixture.connection([check]),
  };
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toBeUndefined();
  check.checkSuite.repository.nameWithOwner = "fixture-org/fixture-repo";
  fixture.finding.author.__typename = "User";
  expect(await fixture.tick()).toBeUndefined();
  fixture.finding.author.__typename = "Bot";
  fixture.finding.author.databaseId = undefined;
  expect(await fixture.tick()).toBeUndefined();
  fixture.finding.author.databaseId = 900;
  check.checkSuite.app.slug = "another-app";
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  check.checkSuite.app.slug = "roboclaw";
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      expect(readObservation(params.prompt).findings).toEqual([
        expect.objectContaining({ id: fixture.finding.id, author: "roboclaw[bot]" }),
      ]);
      return agentResult();
    }),
  );
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
});

it("continues nested overflow in bounded batches without losing comments or replaying earlier no-ops", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.comments = fixture.connection(
    Array.from({ length: 8 }, (_, index) => ({
      ...fixture.finding,
      id: "nested-" + index,
      body: "Review item " + index,
    })),
  );
  fixture.graph.reviewThreads.nodes.push({
    ...fixture.thread,
    id: "thread-2",
    comments: fixture.connection([
      { ...fixture.finding, id: "last-thread", body: "Last thread finding" },
    ]),
  });
  const seen: string[] = [];
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      const observation = readObservation(params.prompt);
      seen.push(...observation.findings.map((f) => f.id));
      expect(observation.findings.length).toBeLessThanOrEqual(3);
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  for (let tick = 0; tick < 5; tick++) {
    await fixture.tick();
  }
  expect(seen).toEqual([
    ...Array.from({ length: 8 }, (_, index) => "nested-" + index),
    "last-thread",
  ]);
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(new Set(seen).size).toBe(9);
  expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({
    enabled: true,
    state: { triggerState: { dispositions: [], quietFindings: expect.any(Array) } },
  });
});
