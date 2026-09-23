import { describe, expect, it } from "vitest";
import {
  normalizeKnownFlakyJobs,
  releaseFlakeIntentSha256,
  selectReleaseFlakeIntent,
  validateReleaseFlakeRecords,
  type ReleaseFlakeRecord,
} from "../../scripts/full-release-flake-policy.mjs";
import {
  executeReleaseFlakeRetry,
  prepareReleaseFlakeRetry,
  verifyReleaseFlakeRetryRecords,
  verifyReleaseFlakeManualRetryAuthority,
  type ReleaseFlakeClient,
} from "../../scripts/full-release-flake-retry.mjs";
import { composeReleaseChildAttemptEvidence } from "../../scripts/full-release-validation-policy.mjs";

const SHA = "a".repeat(40);
const child = {
  key: "normalCi",
  runId: "101",
  runAttempt: 1,
  selected: true,
  displayTitle: "CI full-release-validation-77-1",
  workflow: "ci.yml",
  workflowRef: "release-ci/tooling",
  workflowSha: SHA,
};
const plan = {
  parentRunId: "77",
  sha256: "b".repeat(64),
  repository: "openclaw/openclaw",
  workflowRef: child.workflowRef,
  workflowSha: SHA,
  children: [child],
  knownFlakyJobs: ["normalCi:lane-a", "normalCi:lane-b"],
};
const run = (attempt = 1) => ({
  id: 101,
  run_attempt: attempt,
  event: "workflow_dispatch",
  path: ".github/workflows/ci.yml",
  display_title: child.displayTitle,
  head_branch: child.workflowRef,
  head_sha: SHA,
  repository: { full_name: plan.repository },
  actor: { login: "github-actions[bot]" },
  triggering_actor: { login: "github-actions[bot]" },
  status: "completed",
  conclusion: "failure",
});
const jobs = [
  { id: 501, name: "lane-a", status: "completed", conclusion: "failure" },
  { id: 502, name: "lane-b", status: "completed", conclusion: "success" },
];
function fixture(
  options: { ambiguous?: boolean; reject?: boolean; advanced?: boolean; unresolved?: boolean } = {},
) {
  let attempt = options.advanced ? 2 : 1;
  let clock = 0;
  const mutations: unknown[] = [];
  const records: ReleaseFlakeRecord[] = [];
  const client: ReleaseFlakeClient = {
    async getRun(runId) {
      return runId === "77"
        ? {
            ...run(),
            id: 77,
            path: ".github/workflows/full-release-validation.yml",
            status: "in_progress",
          }
        : run(attempt);
    },
    async getAttempt(_runId, selected) {
      return run(selected);
    },
    async getJobs(_runId, selected) {
      return jobs.map((job) =>
        selected === 1 ? { ...job } : { ...job, id: job.id + 100, conclusion: "success" },
      );
    },
    async getLog() {
      return "";
    },
    async rerun(intent) {
      mutations.push(intent);
      if (options.reject) {
        throw new Error("HTTP 403 Forbidden");
      }
      if (!options.unresolved) {
        attempt = 2;
      }
      if (options.ambiguous || options.unresolved) {
        throw new Error("ECONNRESET");
      }
    },
  };
  return {
    client,
    mutations,
    records,
    record: (value: ReleaseFlakeRecord) => records.push(value),
    ownerDeadlineMs: 330 * 60_000,
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
    },
  };
}

function evidenceFixture(
  context: ReturnType<typeof fixture>,
  intent: NonNullable<ReturnType<typeof selectReleaseFlakeIntent>>,
) {
  const start = "2026-09-22T00:00:00Z";
  const end = "2026-09-22T00:00:01Z";
  const witness = {
    name: "Record automatic retry intent digest",
    status: "completed",
    conclusion: "success",
    number: 2,
    started_at: end,
    completed_at: end,
  };
  const owner = {
    id: 900,
    name: "Automatic retry (normalCi)",
    status: "completed",
    steps: [
      {
        name: "Upload automatic retry intent",
        status: "completed",
        conclusion: "success",
        number: 1,
        started_at: start,
        completed_at: end,
      },
      witness,
      {
        name: "Execute automatic retry",
        status: "completed",
        conclusion: "success",
        number: 3,
        started_at: end,
        completed_at: end,
      },
    ],
  };
  const witnessState = { intent, rejection: "" };
  const verifier = {
    getRun: context.client.getRun.bind(context.client),
    getAttempt: async (runId: string, attempt: number) =>
      runId === "77"
        ? { ...run(1), id: 77, path: ".github/workflows/full-release-validation.yml" }
        : run(attempt),
    getJobs: async (runId: string, attempt: number) =>
      runId === "77" ? [owner] : context.client.getJobs(runId, attempt),
    getLog: async () =>
      `2026-09-22T00:00:01.001Z FRV_AUTO_RETRY_INTENT_SHA256=${releaseFlakeIntentSha256(witnessState.intent)}\n${witnessState.rejection}`,
  };
  return { verifier, owner, witnessState };
}

describe("declared release flake owner", () => {
  it("prepares a targeted retry as soon as its own child completes", async () => {
    const context = fixture();
    const intent = await prepareReleaseFlakeRetry({
      ...context,
      plan,
      childKey: child.key,
      parentAttempt: 1,
    });
    expect(intent).toMatchObject({
      mode: "job",
      sourceRunAttempt: 1,
      expectedRunAttempt: 2,
      jobs: [{ id: "501", name: "lane-a" }],
    });
    expect(context.mutations).toEqual([]);
  });
  it.each([false, true])(
    "sends one mutation and records its replacement with ambiguous response=%s",
    async (ambiguous) => {
      const context = fixture({ ambiguous });
      const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
      const result = await executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 });
      expect(context.mutations).toHaveLength(1);
      expect(context.records[0]).toEqual({
        child: "normalCi",
        executionPlanSha256: plan.sha256,
        intent,
        outcome: "unknown",
        replacements: [],
      });
      expect(result).toEqual({
        child: "normalCi",
        executionPlanSha256: plan.sha256,
        intent,
        outcome: "observed",
        replacements: [{ id: "601", name: "lane-a", runAttempt: 2 }],
      });
    },
  );
  it("spends the automatic wave after any earlier rerun", async () => {
    const context = fixture({ advanced: true });
    expect(
      await prepareReleaseFlakeRetry({ ...context, plan, childKey: child.key, parentAttempt: 1 }),
    ).toBeNull();
    expect(context.mutations).toEqual([]);
  });
  it("still rejects an unknown declared job when a manual attempt consumed the budget", async () => {
    const context = fixture({ advanced: true });
    await expect(
      prepareReleaseFlakeRetry({
        ...context,
        plan: { ...plan, knownFlakyJobs: ["normalCi:missing"] },
        childKey: child.key,
        parentAttempt: 1,
      }),
    ).rejects.toThrow("unknown");
    expect(context.mutations).toEqual([]);
  });
  it("never replays a claimed mutation on a later parent attempt", async () => {
    const context = fixture({ advanced: true });
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    const { verifier } = evidenceFixture(context, intent);
    expect(
      (
        await executeReleaseFlakeRetry({
          ...context,
          client: { ...context.client, ...verifier },
          plan,
          intent,
          parentAttempt: 2,
        })
      ).outcome,
    ).toBe("observed");
    expect(context.mutations).toEqual([]);
  });
  it("keeps an unresolved claim after bounded reads without repeating the POST", async () => {
    const context = fixture({ unresolved: true });
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    await expect(
      executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 }),
    ).rejects.toThrow("must never be replayed");
    expect(context.mutations).toHaveLength(1);
    expect(context.records.at(-1)?.outcome).toBe("unknown");
    expect(context.now()).toBe(context.ownerDeadlineMs);
  });
  it("retains rejection when manual retries repair its jobs in different attempts without artifacts", async () => {
    const context = fixture();
    const failed = jobs.map((job) => ({ ...job, conclusion: "failure" }));
    const second = [{ ...jobs[0]!, id: 601, conclusion: "success", run_attempt: 2 }];
    const third = [{ ...jobs[1]!, id: 702, conclusion: "success", run_attempt: 3 }];
    const attempts = [failed, second, third];
    context.client.getRun = async () => ({ ...run(3), conclusion: "success" });
    context.client.getJobs = async (_id, attempt) => attempts[attempt - 1]!;
    const intent = selectReleaseFlakeIntent(plan, child, run(), failed)!;
    const { verifier, owner, witnessState } = evidenceFixture(context, intent);
    owner.steps[2]!.conclusion = "failure";
    owner.steps.push({
      name: "Record automatic retry rejection digest",
      status: "completed",
      conclusion: "success",
      number: 4,
      started_at: "2026-09-22T00:00:02Z",
      completed_at: "2026-09-22T00:00:03Z",
    });
    witnessState.rejection = `2026-09-22T00:00:02.500Z FRV_AUTO_RETRY_REJECTED_INTENT_SHA256=${releaseFlakeIntentSha256(intent)}\n`;
    const composite = composeReleaseChildAttemptEvidence({
      attempts: attempts.map((rows, index) => ({ runAttempt: index + 1, jobs: rows })),
      expected: { ...child, plannedRunAttempt: 1, repository: plan.repository },
      run: { ...run(3), conclusion: "success" },
    });
    expect(composite).toMatchObject({
      jobs: [
        { name: "lane-a", conclusion: "success" },
        { name: "lane-b", conclusion: "success" },
      ],
    });
    const recovered = await executeReleaseFlakeRetry({
      ...context,
      client: { ...context.client, ...verifier },
      plan,
      intent,
      parentAttempt: 2,
    });
    expect(recovered).toMatchObject({ outcome: "rejected", intent, replacements: [] });
    await expect(
      verifyReleaseFlakeRetryRecords(plan, [recovered], verifier),
    ).resolves.toBeUndefined();
    witnessState.rejection = "";
    await expect(verifyReleaseFlakeRetryRecords(plan, [recovered], verifier)).rejects.toThrow(
      "original witness",
    );
    expect(context.mutations).toEqual([]);
  });
  it("rejects a moved child or altered intent before mutation", async () => {
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    for (const candidate of [intent, { ...intent, runId: "999" }]) {
      const context = fixture({ advanced: true });
      await expect(
        executeReleaseFlakeRetry({ ...context, plan, intent: candidate, parentAttempt: 1 }),
      ).rejects.toThrow();
      expect(context.mutations).toEqual([]);
    }
  });
  it("records a rejected POST without retrying it", async () => {
    const context = fixture({ reject: true });
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    await expect(
      executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 }),
    ).rejects.toThrow("403");
    expect(context.mutations).toHaveLength(1);
    expect(context.records.at(-1)?.outcome).toBe("rejected");
  });
  it("waits for an attempt's transient duplicate job projection without another POST", async () => {
    const context = fixture();
    const getJobs = context.client.getJobs.bind(context.client);
    let reads = 0;
    context.client.getJobs = async (runId, attempt) => {
      const result = await getJobs(runId, attempt);
      if (attempt === 2 && reads++ === 0) {
        return [...result, result[0]!];
      }
      return result;
    };
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    expect(
      (await executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 })).outcome,
    ).toBe("observed");
    expect(reads).toBe(2);
    expect(context.mutations).toHaveLength(1);
  });
  it("holds the retry owner until the complete replacement attempt is terminal and stable", async () => {
    const context = fixture();
    const readAttempt = context.client.getAttempt.bind(context.client);
    const readJobs = context.client.getJobs.bind(context.client);
    let polls = 0;
    context.client.getAttempt = async (runId, attempt) => ({
      ...(await readAttempt(runId, attempt)),
      status: polls++ === 0 ? "in_progress" : "completed",
    });
    context.client.getJobs = async (runId, attempt) => {
      const result = await readJobs(runId, attempt);
      return attempt === 2 && polls === 2 ? [...result, { ...result[1]!, id: 999 }] : result;
    };
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    expect(
      (await executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 })).outcome,
    ).toBe("observed");
    expect(polls).toBe(3);
    expect(context.mutations).toHaveLength(1);
  });
  it("does not renew the shared owner deadline after a slow original attempt", async () => {
    const context = fixture();
    await context.wait(context.ownerDeadlineMs - 1);
    const readAttempt = context.client.getAttempt.bind(context.client);
    context.client.getAttempt = async (runId, attempt) => ({
      ...(await readAttempt(runId, attempt)),
      status: "in_progress",
    });
    const intent = await prepareReleaseFlakeRetry({
      ...context,
      plan,
      childKey: child.key,
      parentAttempt: 1,
    });
    expect(intent).not.toBeNull();
    await expect(
      executeReleaseFlakeRetry({ ...context, plan, intent: intent!, parentAttempt: 1 }),
    ).rejects.toThrow("unresolved");
    expect(context.now()).toBe(context.ownerDeadlineMs);
    expect(context.mutations).toHaveLength(1);
  });
  it("requires current parent authority after the final child read", async () => {
    const context = fixture();
    const readRun = context.client.getRun.bind(context.client);
    context.client.getRun = async (runId) => ({
      ...(await readRun(runId)),
      ...(runId === "77" ? { status: "completed" } : {}),
    });
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    await expect(
      executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 }),
    ).rejects.toThrow("parent is no longer active");
    expect(context.mutations).toEqual([]);
    expect(context.records.at(-1)?.outcome).toBe("rejected");
  });
  it("authenticates retry receipts against the uploaded witness and both native job attempts", async () => {
    const context = fixture();
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    const receipt = await executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 });
    const { verifier, witnessState } = evidenceFixture(context, intent);
    await expect(
      verifyReleaseFlakeRetryRecords(plan, [receipt], verifier),
    ).resolves.toBeUndefined();
    await expect(
      verifyReleaseFlakeRetryRecords(
        plan,
        [{ ...receipt, replacements: [{ id: "999", name: "lane-a", runAttempt: 2 }] }],
        verifier,
      ),
    ).rejects.toThrow("exact attempt two");
    witnessState.intent = { ...intent, jobs: [{ ...intent.jobs[0]!, id: "999" }] };
    await expect(
      verifyReleaseFlakeRetryRecords(plan, [{ ...receipt, intent: witnessState.intent }], verifier),
    ).rejects.toThrow("exact attempt one");
    await expect(
      verifyReleaseFlakeRetryRecords(
        plan,
        [{ ...receipt, intent: null, outcome: "not-attempted", replacements: [] }],
        verifier,
      ),
    ).rejects.toThrow("omits its original intent");
  });
  it.each([
    "rejected",
    "admission-read-failure",
    "unknown",
    "missing",
    "wrong-witness-time",
    "wrong-rejection-digest",
    "wrong-witness",
    "active-owner",
    "skipped-execute",
  ] as const)(
    "permits a manual retry only after authenticated rejection (%s)",
    async (disposition) => {
      const context = fixture();
      const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
      const { verifier, owner, witnessState } = evidenceFixture(context, intent);
      const execution = owner.steps.find((step) => step.name === "Execute automatic retry")!;
      execution.conclusion = disposition === "skipped-execute" ? "skipped" : "failure";
      owner.status = disposition === "active-owner" ? "in_progress" : "completed";
      owner.steps.push({
        name: "Record automatic retry rejection digest",
        status: "completed",
        conclusion: "success",
        number: 4,
        started_at: "2026-09-22T00:00:02Z",
        completed_at: "2026-09-22T00:00:03Z",
      });
      if (disposition === "wrong-witness") {
        witnessState.intent = { ...intent, jobs: [{ ...intent.jobs[0]!, id: "999" }] };
      }
      let record: ReleaseFlakeRecord = {
        child: "normalCi",
        executionPlanSha256: plan.sha256,
        intent,
        outcome: disposition === "unknown" ? "unknown" : "rejected",
        replacements: [],
      };
      if (disposition === "admission-read-failure") {
        const getRun = context.client.getRun.bind(context.client);
        context.client.getRun = async () => {
          throw new Error("ECONNRESET");
        };
        await expect(
          executeReleaseFlakeRetry({ ...context, plan, intent, parentAttempt: 1 }),
        ).rejects.toThrow("ECONNRESET");
        context.client.getRun = getRun;
        record = context.records.at(-1)!;
        expect(record.outcome).toBe("rejected");
      }
      if (disposition === "missing") {
        owner.steps.pop();
      }
      if (record.outcome === "rejected") {
        const timestamp =
          disposition === "wrong-witness-time"
            ? "2026-09-21T00:00:00Z"
            : "2026-09-22T00:00:02.500Z";
        const digest =
          disposition === "wrong-rejection-digest"
            ? "0".repeat(64)
            : releaseFlakeIntentSha256(record.intent!);
        witnessState.rejection = `${timestamp} FRV_AUTO_RETRY_REJECTED_INTENT_SHA256=${digest}\n`;
      }
      const proof = verifyReleaseFlakeManualRetryAuthority({
        plan,
        childKey: child.key,
        client: verifier,
      });
      if (disposition === "rejected" || disposition === "admission-read-failure") {
        await expect(proof).resolves.toEqual({ outcome: "rejected" });
      } else {
        await expect(proof).rejects.toThrow();
      }
      expect(context.mutations).toEqual([]);
    },
  );
  it("requires all original mutation gates skipped before admitting an unattempted manual retry", async () => {
    const context = fixture();
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    const { verifier, owner } = evidenceFixture(context, intent);
    for (const step of owner.steps) {
      step.conclusion = "skipped";
    }
    await expect(
      verifyReleaseFlakeManualRetryAuthority({ plan, childKey: child.key, client: verifier }),
    ).resolves.toEqual({ outcome: "not-attempted" });
    owner.steps[0]!.conclusion = "success";
    await expect(
      verifyReleaseFlakeManualRetryAuthority({ plan, childKey: child.key, client: verifier }),
    ).rejects.toThrow("witness is missing");
    expect(context.mutations).toEqual([]);
  });
  it("uses a failed-jobs wave only when every failed job is declared", () => {
    const twoFailed = jobs.map((job) => ({ ...job, conclusion: "failure" }));
    const undeclared = { id: 503, name: "other", status: "completed", conclusion: "failure" };
    expect(selectReleaseFlakeIntent(plan, child, run(), [...jobs, undeclared])).toMatchObject({
      mode: "job",
      jobs: [{ id: "501", name: "lane-a" }],
    });
    expect(selectReleaseFlakeIntent(plan, child, run(), twoFailed)?.mode).toBe("failed");
    expect(selectReleaseFlakeIntent(plan, child, run(), [...twoFailed, undeclared])).toBeNull();
    expect(selectReleaseFlakeIntent(plan, child, run(2), twoFailed)).toBeNull();
  });
  it("rejects unknown jobs, invalid selectors, and receipts without replacement attempts", () => {
    expect(() => normalizeKnownFlakyJobs(["missing:lane-a"], [child])).toThrow("selected-child");
    expect(() => normalizeKnownFlakyJobs(["normalCi:lane-a", "normalCi:lane-a"])).toThrow(
      "duplicate",
    );
    expect(() =>
      selectReleaseFlakeIntent(
        { ...plan, knownFlakyJobs: ["normalCi:missing"] },
        child,
        run(),
        jobs,
      ),
    ).toThrow("unknown");
    const intent = selectReleaseFlakeIntent(plan, child, run(), jobs)!;
    expect(() =>
      validateReleaseFlakeRecords(
        [
          {
            child: "normalCi",
            executionPlanSha256: plan.sha256,
            intent,
            outcome: "observed",
            replacements: [],
          },
        ],
        plan,
      ),
    ).toThrow("replacement");
    expect(() =>
      validateReleaseFlakeRecords(
        [
          {
            child: "normalCi",
            executionPlanSha256: plan.sha256,
            intent,
            outcome: "observed",
            replacements: [{ id: "601", name: "lane-a", runAttempt: 2 }],
          },
        ],
        plan,
        { normalCi: { runId: "101", observedRunAttempts: [1] } },
      ),
    ).toThrow("absent");
  });
});
