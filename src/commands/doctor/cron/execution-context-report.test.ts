import { describe, expect, it } from "vitest";
import { assembleScheduledAdmissionFacts } from "../../../cron/execution-context-admission.js";
import {
  buildScheduledExecutionContext,
  type ScheduledAdmissionFacts,
} from "../../../cron/execution-context.js";
import { resolveCronRunToolsAllow } from "../../../cron/tools-allow.js";
import type { CronStoredJob } from "../../../cron/types.js";
import {
  classifyScheduledJob,
  emptyScheduledContextReport,
  formatScheduledContextReport,
  type ScheduledJobObservation,
} from "./execution-context-report.js";

const PARENT = "agent:main:dashboard:parent";

function storedJob(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Morning digest",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "digest", toolsAllow: ["read", "automations"] },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  };
}

// A job linked to its creating conversation's exact incarnation by a profile requester.
const linked: Partial<CronStoredJob> = {
  sourceConversation: { sessionKey: PARENT, sessionId: "parent-session", lifecycleRevision: "r1" },
  createdActor: { type: "human", source: "profile", id: "profile-1" },
};

const liveParent = {
  sessionId: "parent-session",
  lifecycleRevision: "r1",
  archived: false,
  sandboxRequired: false,
} as const;

function observe(
  job: CronStoredJob,
  parentRow?: ScheduledAdmissionFacts["parentRow"],
  owner?: boolean,
  extra: Partial<ScheduledJobObservation> = {},
): ScheduledJobObservation {
  const facts = assembleScheduledAdmissionFacts(
    {
      cfg: {},
      job,
      trigger: "cron",
      runId: "doctor",
      agentId: "main",
      runSessionKey: `agent:main:cron:${job.id}:run:doctor`,
      toolsAllow: resolveCronRunToolsAllow(job),
    },
    parentRow,
    owner,
  );
  return {
    job,
    facts,
    result: buildScheduledExecutionContext(job, facts),
    ownerCheck: parentRow ? "checked" : "not-needed",
    ...extra,
  };
}

function classify(...observations: ScheduledJobObservation[]) {
  const report = emptyScheduledContextReport();
  for (const observation of observations) {
    classifyScheduledJob(report, observation);
  }
  return report;
}

describe("scheduled-run access review", () => {
  it("reports a linked job whose creator is no longer an owner with the lost fields", () => {
    const report = classify(observe(storedJob(linked), liveParent, false));
    expect(report.losses).toEqual([
      {
        job: { id: "job-1", name: "Morning digest", enabled: true },
        ownerCheck: "checked",
        fields: [
          expect.objectContaining({
            field: "ownerEmbedded",
            legacy: "owner",
            context: "non-owner",
            label: "loss",
          }),
        ],
      },
    ]);
    expect(formatScheduledContextReport(report)).toContain(
      "- Morning digest (job-1): owner-only tools such as sessions, portal, nodes, gateway and plugins",
    );
  });

  it("reports a loss the Gateway must confirm as unverified", () => {
    const observation = observe(storedJob(linked), liveParent, false, { ownerCheck: "unverified" });
    expect(formatScheduledContextReport(classify(observation))).toContain(
      "Doctor could not verify it",
    );
  });

  it("reports a sandbox the parent conversation requires as lost unsandboxed access", () => {
    const report = classify(
      observe(storedJob(linked), { ...liveParent, sandboxRequired: true }, true),
    );
    expect(report.losses[0]?.fields.map((field) => field.field)).toEqual(["sandbox"]);
  });

  it("reports a session-target job's yield and CLI automations narrowing", () => {
    // The collector runs a session-target job in its target session.
    const job = storedJob({ sessionTarget: `session:${PARENT}` });
    const facts = assembleScheduledAdmissionFacts(
      {
        cfg: {},
        job,
        trigger: "cron",
        runId: "doctor",
        agentId: "main",
        runSessionKey: PARENT,
        toolsAllow: resolveCronRunToolsAllow(job),
      },
      undefined,
      undefined,
    );
    const report = classify({
      job,
      facts,
      result: buildScheduledExecutionContext(job, facts),
      ownerCheck: "not-needed",
    });
    expect(report.losses[0]?.fields.map((field) => field.field)).toEqual([
      "automationsCli",
      "requesterYield",
    ]);
    const text = formatScheduledContextReport(report);
    expect(text).toContain("1 automation will lose access at the next run:");
    expect(text).toContain("unscoped automations tool on CLI backends");
    expect(text).toContain("sessions_yield (scheduled runs cannot wait for child sessions");
  });

  it("does not report a linked job whose creator is still an owner", () => {
    const report = classify(observe(storedJob(linked), liveParent, true));
    expect(report.losses).toEqual([]);
    expect(formatScheduledContextReport(report)).toBeNull();
  });

  it.each([
    ["removed", { missing: true } as const, "was removed"],
    ["archived", { ...liveParent, archived: true }, "is archived"],
  ])("reports a job whose parent was %s as pausing", (cause, parentRow, text) => {
    const report = classify(observe(storedJob(linked), parentRow, true));
    expect(report.pauses).toEqual([expect.objectContaining({ parentSessionKey: PARENT, cause })]);
    expect(formatScheduledContextReport(report)).toContain(`\`${PARENT}\` ${text}`);
  });

  it("reports a job whose parent worktree is missing as pausing with the path", () => {
    const parentRow = {
      ...liveParent,
      cwd: "/work/tree",
      worktree: { path: "/work/tree", exists: false },
    };
    const report = classify(observe(storedJob(linked), parentRow, true));
    expect(report.pauses).toEqual([
      expect.objectContaining({ cause: "worktree-missing", worktreePath: "/work/tree" }),
    ]);
    expect(formatScheduledContextReport(report)).toContain("has a missing worktree (`/work/tree`)");
  });

  it("reports key-only and reset parent links as unbound", () => {
    const keyOnly = storedJob({
      id: "job-key",
      owner: { agentId: "main", sessionKey: PARENT },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: PARENT,
        ownerAccountId: "default",
      },
    });
    const reset = storedJob({ ...linked, id: "job-reset" });
    const report = classify(
      observe(keyOnly),
      observe(reset, { ...liveParent, sessionId: "next-session" }, true),
    );
    expect(report.unbound).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: "job-key" }),
        cause: "key-only",
      }),
      expect.objectContaining({
        job: expect.objectContaining({ id: "job-reset" }),
        cause: "reset",
      }),
    ]);
    expect(report.losses).toEqual([]);
  });

  it("does not report operator jobs with no parent", () => {
    expect(formatScheduledContextReport(classify(observe(storedJob())))).toBeNull();
  });

  it("reports owner-context jobs on a CLI backend as a runtime owner difference", () => {
    const report = classify(
      observe(storedJob(), undefined, undefined, { cliBackend: "claude-cli" }),
      observe(storedJob({ ...linked, id: "job-2" }), liveParent, false, {
        cliBackend: "claude-cli",
      }),
    );
    // Only the owner context gains owner-only tools on the CLI backend.
    expect(report.runtimeOwner).toEqual([
      { job: expect.objectContaining({ id: "job-1" }), cliBackend: "claude-cli" },
    ]);
    expect(formatScheduledContextReport(report)).toContain("- Morning digest (job-1): claude-cli");
  });

  it("reports a linked root conversation with no stored chat type", () => {
    const report = classify(
      observe(storedJob(linked), liveParent, true, { parentChat: { spawned: false } }),
      observe(storedJob({ ...linked, id: "job-2" }), liveParent, true, {
        parentChat: { spawned: false, chatType: "direct" },
      }),
      observe(storedJob({ ...linked, id: "job-3" }), liveParent, true, {
        parentChat: { spawned: true },
      }),
    );
    expect(report.missingChatType).toEqual([
      { job: expect.objectContaining({ id: "job-1" }), parentSessionKey: PARENT },
    ]);
    expect(formatScheduledContextReport(report)).toContain("no stored chat type");
  });

  it("lists a job whose stored authority cannot be decoded", () => {
    const job = storedJob({
      operatorSource: { source: { version: 1 }, executionRevision: "x" } as never,
    });
    const report = classify(observe(job));
    expect(report.failed).toEqual([
      expect.objectContaining({ reason: "stored operator source is invalid" }),
    ]);
  });
});
