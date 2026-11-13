// oxfmt-ignore
import {
  createFixture,
  agentResult,
  readObservation,
  collectFindingIds,
  recordJudgment,
} from "./service.pr-automation.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { admitModelTurn } from "../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgentMock } from "./isolated-agent/run.test-harness.js";
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
  const observed = fixture.triggerState();
  expect(observed).toMatchObject({
    version: 3,
    blocked: expect.stringContaining("Awaiting verified"),
  });
  await fixture.expectQuietTicks(12);
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
  await fixture.expectQuietTicks(3);
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  fixture.thread.isResolved = true;
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  const handled = fixture.triggerState();
  expect(
    handled,
    JSON.stringify(fixture.execution.getJob(fixture.selected.id)?.state),
  ).toMatchObject({
    disposition: { status: "blocked" },
  });
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.triggerState()).toEqual(handled);
  fixture.failRead(true);
  expect(await fixture.tick()).toMatchObject({
    status: "error",
    error: expect.stringContaining("GitHub PR state is unavailable"),
  });
  expect(fixture.triggerState()).toEqual(handled);
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(true);
  fixture.failRead(false);
  expect(await fixture.tick()).toBeUndefined();
  expect(fixture.triggerState()).toEqual(handled);
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
  collectFindingIds(fixture, undefined);
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  const initial = fixture.triggerState();
  fixture.finding.body = "Edited review: handle the real failure";
  fixture.finding.updatedAt = "2026-11-10T11:00:00Z";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(fixture.triggerState()).not.toEqual(initial);
  fixture.pr.head.sha = "c".repeat(40);
  fixture.graph.headRefOid = fixture.pr.head.sha;
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.oid = fixture.pr.head.sha;
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(fixture.triggerState()).toMatchObject({
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
  const check = fixture.checkRuns();
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

it.each([1, 800])(
  "%s checks: keeps unchanged failing CI quiet independently of successful unresolved feedback batches",
  async (checkCount) => {
    await using fixture = await createFixture("autoFix");
    const items = fixture.issueComments(4, (index) => ({ id: "comment-" + index }));
    const check = fixture.checkRuns(checkCount);
    const seen: string[][] = [];
    collectFindingIds(fixture, undefined, (observation) => {
      seen.push(observation.findings.map((f) => f.id));
    });
    await fixture.execution.update(fixture.selected.id, { enabled: true });
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    const progress = fixture.triggerState();
    expect(progress).toMatchObject({ scan: { apps: ["github-actions[bot]"], failures: 1 } });
    if (checkCount === 800) {
      expect(asRecord(progress).scan).toMatchObject({ source: 0, cursor: "320" });
    }
    fixture.execution.stop();
    await fixture.execution.waitForIdle();
    await fixture.execution.start();
    expect(fixture.triggerState()).toEqual(progress);
    await fixture.expectSuccessfulTicks(14);
    const batches = [
      ...(checkCount === 800 ? [[]] : []),
      items.slice(0, 3).map((f) => f.id),
      [expectDefined(items[3], "fourth finding").id],
    ];
    expect(seen).toEqual(batches);
    expect(fixture.triggerState()).toMatchObject({
      dispositions: [],
      blocked: expect.stringContaining("unresolved"),
    });
    check.id = "run-2";
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    await fixture.expectSuccessfulTicks(5);
    expect(seen).toEqual([...batches, []]);
  },
);

it("pauses before replacing an unobserved attempt whose native payload history expired", async () => {
  await using fixture = await createFixture("autoFix");
  const items = fixture.issueComments(4, (index) => ({ id: "comment-" + index }));
  const seen: string[] = [];
  collectFindingIds(fixture, seen);
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  const attempt = asRecord(fixture.triggerState()).attempt;
  const attemptAtMs = asRecord(attempt).atMs;
  assert(typeof attemptAtMs === "number", "Missing observed attempt timestamp");
  const readHistory = () => fixture.runHistory(`cron:${fixture.selected.id}:${attemptAtMs}`);
  expect(readHistory()).toHaveLength(1);
  await fixture.expireRunHistory();
  expect(readHistory()).toEqual([]);
  await fixture.execution.start();
  await fixture.expectQuietTicks(12);
  expect(seen).toEqual(items.slice(0, 3).map((f) => f.id));
  expect(fixture.triggerState()).toMatchObject({
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
      await admitModelTurn(params);
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
      error: expect.stringContaining("Synthetic provider unavailable"),
    });
    const state = asRecord(fixture.triggerState());
    const attempt = asRecord(state.attempt);
    expect(attempt.atMs).toEqual(expect.any(Number));
    expect(state.retries).toBe(retry);
    if (retry === 0) {
      fingerprint = attempt.fingerprint;
    }
    expect(attempt.fingerprint).toBe(fingerprint);
    assert(typeof attempt.atMs === "number", "Missing persisted payload attempt");
    attempts.push(attempt.atMs);
    expect(fixture.runHistory("cron:" + fixture.selected.id + ":" + attempt.atMs)).toEqual([
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
      expect(fixture.triggerState()).toMatchObject({
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
    expect(fixture.triggerState()).toMatchObject({
      retries: phase === "verify" ? 4 : 5,
      retryTicks: 0,
      attempt: { fingerprint },
    });
  }
  expect(revisions).toHaveLength(2);
  expect(revisions[1]).toBe(revisions[0]);
  const calls = runEmbeddedAgentMock.mock.calls.length;
  await fixture.expectQuietTicks(12);
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
    expect(fixture.triggerState()).toEqual(
      mode === "replacement" ? { replacement: "current owner" } : previous,
    );
  },
);

it.each([
  "comment",
  "quiet-thread",
  "not-actionable-thread",
  "quiet-cursor",
  "not-actionable-cursor",
])("%s: retains exact-revision dedupe but reassesses observed reopened feedback", async (mode) => {
  await using fixture = await createFixture("autoFix");
  const quiet = mode.startsWith("quiet");
  const paged = mode.endsWith("cursor");
  if (paged) {
    const following = structuredClone(fixture.thread);
    following.id = "thread-2";
    following.isResolved = true;
    expectDefined(following.comments.nodes[0], "following comment").id = "review-comment-2";
    fixture.graph.reviewThreads = fixture.connection([fixture.thread, following]);
  }
  fixture.thread.isResolved = mode === "comment";
  fixture.finding.body = "The error path now looks correct. Thanks!";
  fixture.graph.comments = fixture.connection(mode === "comment" ? [fixture.finding] : []);
  collectFindingIds(fixture, undefined, async (observation, automation) => {
    const finding = expectDefined(observation.findings[0], "observed finding");
    if (quiet) {
      return;
    }
    await recordJudgment({
      automation,
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
      summary: "Inspected the exact current praise revision",
    });
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  if (paged) {
    expect(asRecord(fixture.triggerState()).scan).toMatchObject({ cursor: "1" });
    fixture.thread.isResolved = true;
  }
  expect(await fixture.tick()).toBeUndefined();
  expect(fixture.triggerState()).toMatchObject({
    dispositions: quiet
      ? []
      : [
          expect.objectContaining({
            id: fixture.finding.id,
            status: "not_actionable",
            reason: expect.stringContaining("already-correct"),
            quote: fixture.finding.body,
          }),
        ],
    disposition: { status: quiet ? "blocked" : "reviewed" },
  });
  if (!paged) {
    await fixture.expectQuietTicks(12);
    fixture.thread.isResolved = true;
    await fixture.expectQuietTicks(2);
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  if (mode !== "comment") {
    fixture.execution.stop();
    await fixture.execution.waitForIdle();
    await fixture.execution.start();
    fixture.thread.isResolved = false;
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    await fixture.expectQuietTicks(12);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  }
  fixture.finding.body = "Correction: the timeout still fails";
  fixture.finding.updatedAt = "2026-11-10T15:00:00Z";
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(mode === "comment" ? 2 : 3);
});

it("keeps accumulated Unicode disposition evidence within Cron’s real 16KB state budget", async () => {
  await using fixture = await createFixture("autoFix");
  const items = fixture.issueComments(24, (index) => ({
    id: "praise-" + index,
    body: "Looks good " + "🦞".repeat(200),
  }));
  const seen: string[] = [];
  collectFindingIds(fixture, seen, async (observation, automation) => {
    await recordJudgment({
      automation,
      url: fixture.pr.html_url,
      head: observation.head,
      attempt: observation.fingerprint,
      findings: observation.findings.map((finding) => ({
        id: finding.id,
        revision: finding.revision,
        status: "not_actionable",
        reason: "🦞".repeat(240),
        quote: "🦞".repeat(200),
      })),
      summary: "Inspected current praise revisions",
    });
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  await fixture.expectSuccessfulTicks(9, () => {
    expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({ enabled: true });
  });
  expect(seen).toEqual(items.map((item) => item.id));
  await fixture.expectQuietTicks(12);
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(8);
  const state = asRecord(fixture.triggerState());
  expect(state.dispositions).toHaveLength(24);
  expect(state.disposition).toMatchObject({ status: "reviewed" });
});

it("retains more than 128 exact Unicode no-op revisions across inventories and history expiry", async () => {
  await using fixture = await createFixture("autoFix");
  const items = fixture.issueComments(132, (index) => ({
    id: "🦞".repeat(20) + index,
    body: "Unresolved review " + index,
  }));
  const seen: string[] = [];
  collectFindingIds(fixture, seen);
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  await fixture.expectSuccessfulTicks(45);
  expect(seen).toEqual(items.map((f) => f.id));
  // Receipt state survives scheduler reload beyond native run-history retention.
  await fixture.expireRunHistory();
  expect(fixture.runHistory()).toEqual([]);
  await fixture.execution.start();
  // Successful no-op receipts suppress unchanged feedback, not claim resolution.
  await fixture.expectQuietTicks(100);
  expect(seen).toEqual(items.map((f) => f.id));
  expectDefined(items[0], "first finding").updatedAt = "2026-11-10T17:00:00Z";
  await fixture.expectSuccessfulTicks(45);
  expect(seen.slice(132)).toEqual([expectDefined(items[0], "first finding").id]);
});

it("pauses model work instead of replaying forgotten revisions when exact receipt state is full", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.issueComments(320, (index) => ({ id: "feedback-" + index }));
  const seen: string[] = [];
  collectFindingIds(fixture, seen);
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  let paused = false;
  await fixture.expectSuccessfulTicks(110, () => {
    const state = asRecord(fixture.triggerState());
    paused = String(state.blocked).includes("model work is paused");
    return !paused;
  });
  expect(paused).toBe(true);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.length).toBeLessThan(320);
  expect(new Set(seen).size).toBe(seen.length);
  const calls = runEmbeddedAgentMock.mock.calls.length;
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  fixture.advanceTime(8 * 24 * 60 * 60_000);
  await fixture.execution.start();
  await fixture.expectQuietTicks(12);
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(calls);
  expect(asRecord(fixture.triggerState()).blocked).toContain("manual review, not resolved");
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
  collectFindingIds(fixture, undefined, (observation) => {
    expect(observation.findings).toEqual([
      expect.objectContaining({ id: fixture.finding.id, author: "renamed-outside-author" }),
    ]);
  });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
});

it("admits a repository/head App bot while refusing spelling, identity and integration spoofs", async () => {
  await using fixture = await createFixture("autoFix");
  fixture.thread.isResolved = true;
  fixture.finding.authorAssociation = "NONE";
  fixture.finding.author = { login: "roboclaw[bot]", __typename: "Bot", databaseId: 900 };
  fixture.graph.comments = fixture.connection([fixture.finding]);
  const check = fixture.checkRuns(1, "SUCCESS", "roboclaw");
  check.checkSuite.repository.nameWithOwner = "unrelated/repo";
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
  collectFindingIds(fixture, undefined, (observation) => {
    expect(observation.findings).toEqual([
      expect.objectContaining({ id: fixture.finding.id, author: "roboclaw[bot]" }),
    ]);
  });
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
  collectFindingIds(fixture, seen, (observation) => {
    expect(observation.findings.length).toBeLessThanOrEqual(3);
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  await fixture.expectSuccessfulTicks(5);
  expect(seen).toEqual([
    ...Array.from({ length: 8 }, (_, index) => "nested-" + index),
    "last-thread",
  ]);
  await fixture.expectQuietTicks(12);
  expect(new Set(seen).size).toBe(9);
  expect(fixture.execution.getJob(fixture.selected.id)).toMatchObject({
    enabled: true,
    state: { triggerState: { dispositions: [], quietFindings: expect.any(Array) } },
  });
});
