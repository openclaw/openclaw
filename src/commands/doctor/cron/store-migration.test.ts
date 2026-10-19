import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { QuarantinedCronConfigJob } from "../../../cron/types-shared.js";
import { legacyCodexProviderIdentityKey } from "../shared/codex-route-model-ref.js";
import { TASK_SUGGESTION_TOOL_NAME_MIGRATION } from "../shared/legacy-tool-name-migration.js";
import {
  planCronCodexRefRewriteAgainstPersistedConfig,
  repairCronCodexRuntimePolicies,
} from "./runtime-policy-migration.js";
import {
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
  recoverValidQuarantinedCronScheduleJobs,
} from "./store-migration.js";

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    agentId: undefined,
    name: "Legacy job",
    description: null,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...overrides,
  };
}

function normalizeOneJob(
  job: Record<string, unknown>,
  options: Parameters<typeof normalizeStoredCronJobs>[1] = {},
) {
  const jobs = [job];
  const result = normalizeStoredCronJobs(jobs, options);
  return { job: expectDefined(jobs[0], "normalized job"), result };
}

function normalizeLegacyJob(overrides: Record<string, unknown>) {
  return normalizeOneJob(makeLegacyJob(overrides));
}

const commandPrompt = (command: string, cwd: string) =>
  `Command to run:\n- command: ${command}\n- workdir: ${cwd}`;

function modelJobs(payload: Record<string, unknown> = {}, agentId?: string) {
  return [
    makeLegacyJob({
      agentId,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "ping", model: "codex/gpt-5.6-sol", ...payload },
    }),
  ];
}

function normalizeWithBlockedTargets(
  jobs: Record<string, unknown>[],
  targets: Parameters<typeof cronCodexRuntimePolicyTargetKey>[0][],
) {
  const blocked = new Set(targets.map(cronCodexRuntimePolicyTargetKey));
  return normalizeStoredCronJobs(jobs, {
    migrateCodexModelRefs: true,
    shouldMigrateCodexRuntimePolicyTarget: (target) =>
      !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
  });
}

describe("normalizeStoredCronJobs", () => {
  it("normalizes legacy cron fields and reports migration issues", () => {
    const jobs = [
      {
        jobId: "legacy-job",
        schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
        message: "say hi",
        model: "openai/gpt-5.5",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "12345",
        threadId: " 77 ",
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result).toMatchObject({
      mutated: true,
      issues: {
        jobId: 1,
        legacyScheduleCron: 1,
        legacyTopLevelPayloadFields: 1,
        legacyTopLevelDeliveryFields: 1,
      },
    });
    expect(jobs[0]).toMatchObject({
      id: "legacy-job",
      schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
      delivery: { mode: "announce", channel: "telegram", to: "12345", threadId: "77" },
      payload: { kind: "agentTurn", message: "say hi", model: "openai/gpt-5.5" },
    });
    for (const key of ["jobId", "message", "provider"]) {
      expect(jobs[0]?.[key]).toBeUndefined();
    }
  });

  it("normalizes payload provider alias into channel", () => {
    const jobs = [
      {
        id: "legacy-provider",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "ping", provider: " Slack " },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadProvider).toBe(1);
    expect(jobs[0]).toMatchObject({
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "slack" },
    });
    expect(jobs[0]?.payload).not.toHaveProperty("provider");
  });

  it.each([
    {
      issue: "legacyTaskSuggestionToolName",
      before: ["read", TASK_SUGGESTION_TOOL_NAME_MIGRATION.legacyName],
      after: ["read", "suggest_task"],
    },
    { issue: "legacyImageInspectionToolName", before: ["image*"], after: ["image*", "view_image"] },
  ])("migrates $issue in persisted tool allowlists", ({ issue, before, after }) => {
    const { job, result } = normalizeLegacyJob({
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "ping", toolsAllow: before },
    });
    expect(result).toMatchObject({ mutated: true, issues: { [issue]: 1 } });
    expect(job).toHaveProperty("payload.toolsAllow", after);
  });

  it("rewrites shipped codex model refs in cron payloads", () => {
    const { job, result } = normalizeOneJob(modelJobs({ fallbacks: ["codex/gpt-5.4-mini"] })[0]!, {
      migrateCodexModelRefs: true,
    });

    expect(result).toMatchObject({ mutated: true, issues: { legacyPayloadCodexModel: 1 } });
    expect(job).toMatchObject({
      payload: { model: "openai/gpt-5.6-sol", fallbacks: ["openai/gpt-5.4-mini"] },
    });
    const runtimeRepair = repairCronCodexRuntimePolicies({
      cfg: { agents: { entries: { main: { default: true } } } },
      targets: result.codexRuntimePolicyTargets,
    });
    expect(runtimeRepair.warnings).toStrictEqual([]);
    expect(runtimeRepair.config.agents?.entries?.main?.models).toMatchObject({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
      "openai/gpt-5.4-mini": { agentRuntime: { id: "codex" } },
    });
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: runtimeRepair.config,
      }).runtime,
    ).toBe("codex");
  });

  it("keeps the whole provider-conflicted cron namespace legacy", () => {
    const jobs = modelJobs({ fallbacks: ["codex/gpt-5.3-mini"] });
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked cron namespace test invariant",
    );
    const policyPlan = repairCronCodexRuntimePolicies({
      cfg: {},
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
      blockedModelIdentities: new Set([blockedNamespace]),
    });
    normalizeWithBlockedTargets(jobs, policyPlan.blockedTargets);

    expect(jobs[0]).toMatchObject({
      payload: { model: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.3-mini"] },
    });
    expect(policyPlan.config.agents?.defaults?.models).toBeUndefined();
  });

  it("retains a default-agent cron ref when its list-entry runtime conflicts", () => {
    const jobs = modelJobs();
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: {
        agents: {
          list: [
            {
              id: "primary",
              default: true,
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
            },
          ],
        },
      },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    normalizeWithBlockedTargets(jobs, rewritePlan.blockedTargets);

    expect(rewritePlan.warnings.join("\n")).toContain(
      'Retained agents.list.primary.models.openai/gpt-5.6-sol.agentRuntime.id="openclaw"',
    );
    expect(jobs[0]).toHaveProperty("payload.model", "codex/gpt-5.6-sol");
  });

  it("writes a named default agent policy to its list entry before rewriting cron", () => {
    const jobs = modelJobs({}, "primary");
    const targets = collectStoredCronCodexRuntimePolicyTargets(jobs);
    const policyRepair = repairCronCodexRuntimePolicies({
      cfg: { agents: { list: [{ id: "primary", default: true }] } },
      targets,
    });

    expect(policyRepair.config.agents?.list?.[0]?.models).toMatchObject({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
    });
    expect(policyRepair.config.agents?.defaults?.models).toBeUndefined();
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: policyRepair.config,
      targets,
    });
    expect(rewritePlan).toStrictEqual({ warnings: [], blockedTargets: [] });
    normalizeWithBlockedTargets(jobs, rewritePlan.blockedTargets);
    expect(jobs[0]).toHaveProperty("payload.model", "openai/gpt-5.6-sol");
  });

  it.each<{
    name: string;
    agents: NonNullable<OpenClawConfigWithLegacyRoster["agents"]>;
    agentId?: string;
    expectedAgentId: string;
  }>([
    {
      name: "sole configured agent",
      agents: { entries: { ops: {} } },
      expectedAgentId: "ops",
    },
    {
      name: "configured system agent under explicit ownership",
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
      expectedAgentId: "ops",
    },
    {
      name: "explicit job owner before the configured system agent",
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
      agentId: "main",
      expectedAgentId: "main",
    },
  ])("writes policy only to the $name", ({ agents, agentId, expectedAgentId }) => {
    const jobs = [
      makeLegacyJob({
        id: "implicit-default-codex-model",
        agentId,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const policyRepair = repairCronCodexRuntimePolicies({
      cfg: { agents },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });

    expect(jobs[0]?.agentId).toBe(agentId);
    expect(policyRepair.config.agents?.entries?.[expectedAgentId]?.models).toEqual({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
    });
    for (const [entryId, entry] of Object.entries(policyRepair.config.agents?.entries ?? {})) {
      if (entryId !== expectedAgentId) {
        expect(entry.models).toBeUndefined();
      }
    }
    expect(policyRepair.config.agents?.defaults?.models).toBeUndefined();
    expect(policyRepair.warnings).toEqual([]);
    expect(policyRepair.blockedTargets).toEqual([]);
  });

  it("retains a post-snapshot Codex ref until its runtime policy is persisted", () => {
    const jobs = modelJobs();
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: { agents: { entries: { main: { default: true } } } },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    const result = normalizeWithBlockedTargets(jobs, rewritePlan.blockedTargets);

    expect(rewritePlan.warnings).toEqual([
      expect.stringContaining("policy is not present in persisted config"),
    ]);
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
    expect(jobs[0]).toHaveProperty("payload.model", "codex/gpt-5.6-sol");
  });

  it("does not rewrite Codex refs during an ordinary cron normalization pass", () => {
    const { job, result } = normalizeOneJob(modelJobs()[0]!);

    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
    expect(job).toHaveProperty("payload.model", "codex/gpt-5.6-sol");
  });

  it("converts legacy agent command prompts into command cron payloads", () => {
    const command =
      "cd /home/openclaw/.razor/quant && ./scripts/system/run_position_control.sh --write-card --silent-token NO_REPLY";
    const { job, result } = normalizeLegacyJob({
      id: "quant-position-card",
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: `${commandPrompt(command, "/home/openclaw/.razor/quant")}\n- timeout: 840`,
        toolsAllow: ["group:runtime"],
        lightContext: true,
        timeoutSeconds: 900,
        model: "openai/gpt-5.5",
        deliver: true,
        channel: "telegram",
        to: "123",
      },
    });

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyAgentTurnCommandPayload).toBe(1);
    expect(job.delivery).toEqual({ mode: "announce", channel: "telegram", to: "123" });
    expect(job.payload).toEqual({
      kind: "command",
      argv: ["sh", "-lc", command],
      cwd: "/home/openclaw/.razor/quant",
      timeoutSeconds: 900,
    });
  });

  it("does not convert command-shaped prompts without shell tool access", () => {
    const command = "python3 scripts/check_mail.py";
    const { job, result } = normalizeLegacyJob({
      id: "restricted-command-prompt",
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: commandPrompt(command, "/home/openclaw/.razor/clawd"),
        toolsAllow: ["read", "message"],
      },
    });

    expect(result.issues.legacyAgentTurnCommandPayload).toBeUndefined();
    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
    expect(result.unresolvedAgentTurnCommandPromptJobs).toEqual(["Legacy job"]);
    expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual([]);
    expect(job.payload).toMatchObject({
      kind: "agentTurn",
      message: expect.stringContaining(command),
      toolsAllow: ["read", "message"],
    });
  });

  it("rewrites legacy systemEvent message payloads to text", () => {
    const { result } = normalizeLegacyJob({
      id: "legacy-system-event-message",
      payload: { kind: "systemEvent", message: "tick" },
    });

    expect(result.mutated).toBe(true);
    expect(result.jobs[0]?.payload).toEqual({ kind: "systemEvent", text: "tick" });
    expect(result.removedJobs).toEqual([]);
  });

  it("removes unrepairable persisted schedule and payload shapes", () => {
    const jobs = [
      makeLegacyJob({ id: "valid" }),
      makeLegacyJob({ id: "bad-schedule", schedule: { kind: "cron", expr: [] } }),
      makeLegacyJob({ id: "bad-payload", payload: { kind: "agentTurn", message: ["tick"] } }),
      makeLegacyJob({ id: "missing-schedule", schedule: undefined }),
      makeLegacyJob({ id: "missing-payload", payload: undefined }),
      makeLegacyJob({
        id: "incomplete-system-payload",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        payload: { kind: "systemEvent" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBe(2);
    expect(result.issues.invalidPayload).toBe(3);
    expect(jobs.map((job) => job.id)).toEqual(["valid"]);
    expect(result.jobs.map((job) => job.id)).toEqual(["valid"]);
  });

  it("does not normalize unsupported payload kinds into runnable cron jobs", () => {
    const jobs = [
      makeLegacyJob({
        id: "legacy-command-kind",
        payload: { kind: "command", command: "echo daily" },
      }),
      makeLegacyJob({
        id: "legacy-agentmessage-kind",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentmessage", message: "summarize" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidPayload).toBe(2);
    expect(jobs).toEqual([]);
    expect(result.jobs).toEqual([]);
  });

  it("normalizes whitespace-padded and non-canonical payload kinds", () => {
    const jobs: Array<Record<string, unknown>> = [
      {
        id: "spaced-agent-turn",
        payload: { kind: " agentTurn ", message: "ping" },
        sessionTarget: "isolated",
      },
      {
        id: "upper-system-event",
        payload: { kind: "SYSTEMEVENT", text: "pong" },
        sessionTarget: "main",
      },
    ].map((job) =>
      Object.assign(
        {
          name: "normalized",
          enabled: true,
          wakeMode: "now",
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
          delivery: { mode: "announce" },
          state: {},
        },
        job,
      ),
    );

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect(jobs.map((job) => job.payload)).toEqual([
      { kind: "agentTurn", message: "ping" },
      { kind: "systemEvent", text: "pong" },
    ]);
  });

  it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
    const { job, result } = normalizeLegacyJob({
      id: "job-1",
      sessionKey: "  agent:main:discord:channel:ops  ",
      schedule: { kind: "at", atMs: 1_700_000_000_000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "telegram",
        to: "7200373102",
        bestEffortDeliver: true,
      },
      isolation: { postToMainPrefix: "Cron" },
    });

    expect(result.mutated).toBe(true);
    expect(job.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "7200373102",
      bestEffort: true,
    });
    expect("isolation" in job).toBe(false);
    const payload = job.payload as Record<string, unknown>;
    for (const key of ["deliver", "channel", "to", "bestEffortDeliver"]) {
      expect(payload[key]).toBeUndefined();
    }
    expect(job.schedule).toMatchObject({
      kind: "at",
      at: new Date(1_700_000_000_000).toISOString(),
    });
    expect((job.schedule as Record<string, unknown>).atMs).toBeUndefined();
  });

  it.each([
    { kind: "at", at: "2026-04-01T12:00:00+02:00" },
    { kind: "at", at: "2026-04-01T10:00:00.000Z", atMs: undefined },
    { kind: "at", at: "2026-04-01T11:00:00.000Z", atMs: 1_775_037_600_000 },
  ])("repairs a noncanonical one-shot schedule once: %j", (schedule) => {
    const jobs = [makeLegacyJob({ description: undefined, schedule: { ...schedule } })];

    expect(normalizeStoredCronJobs(jobs).mutated).toBe(true);
    expect(jobs[0]?.schedule).toEqual({ kind: "at", at: "2026-04-01T10:00:00.000Z" });
    expect(normalizeStoredCronJobs(jobs).mutated).toBe(false);
  });

  it("leaves Date-invalid legacy atMs for persisted shape validation", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-invalid-at",
        schedule: { kind: "at", atMs: 8_700_000_000_000_000 },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBe(1);
    expect(job).toBeUndefined();
  });

  it("drops Date-invalid legacy atMs when canonical at is valid", () => {
    const at = "2026-04-01T10:00:00.000Z";
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-valid-at-invalid-at-ms",
        schedule: { kind: "at", at, atMs: 8_700_000_000_000_000 },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect(schedule.at).toBe(at);
    expect(schedule.atMs).toBeUndefined();
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
    const { job } = normalizeLegacyJob({
      id: "job-cron-minute-legacy",
      name: "Legacy minute cron",
      schedule: { kind: "cron", expr: "17 * * * *", tz: "UTC", staggerMs: "bogus" },
    });

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });

  it("migrates legacy string schedules and command-only payloads (#18445)", () => {
    const { job, result } = normalizeOneJob({
      id: "imessage-refresh",
      name: "iMessage Refresh",
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: "0 */2 * * *",
      command: "bash /tmp/imessage-refresh.sh",
      timeout: 120,
      state: {},
    });

    expect(result.mutated).toBe(true);
    expect(job).toMatchObject({
      schedule: { kind: "cron", expr: "0 */2 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
    });
    expect(job.payload).toEqual({ kind: "systemEvent", text: "bash /tmp/imessage-refresh.sh" });
    expect("command" in job).toBe(false);
    expect("timeout" in job).toBe(false);
  });

  it("canonicalizes a recognized stream schedule and its mode", () => {
    const { job, result } = normalizeLegacyJob({
      schedule: { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " },
    });

    expect(result.removedJobs).toEqual([]);
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect(job.schedule).toEqual({ kind: "stream", command: ["node", "events.mjs"], mode: "line" });
  });

  it("recovers only currently valid schedule rows and preserves recovery state", () => {
    const makeEntry = (
      sourceIndex: number,
      id: string,
      schedule: Record<string, unknown>,
      overrides: Partial<QuarantinedCronConfigJob> = {},
    ): QuarantinedCronConfigJob => ({
      sourceIndex,
      reason: "invalid-schedule",
      job: makeLegacyJob({ id, name: id, schedule }),
      ...overrides,
    });
    const entries: QuarantinedCronConfigJob[] = [
      makeEntry(
        0,
        "variant",
        { kind: " CRON ", expr: "0 7 * * *" },
        { state: { nextRunAtMs: 123 }, updatedAtMs: 456 },
      ),
      makeEntry(1, "canonical", { kind: "every", everyMs: 60_000, anchorMs: 1 }),
      makeEntry(2, "unknown", { kind: "daily", at: "09:00" }),
      makeEntry(3, "existing", { kind: "cron", expr: "0 8 * * *" }),
      makeEntry(
        4,
        "other-reason",
        { kind: "cron", expr: "0 9 * * *" },
        { reason: "missing-payload" },
      ),
      makeEntry(5, "every", { kind: "Every", everyMs: 60_000 }),
    ];

    const result = recoverValidQuarantinedCronScheduleJobs(entries, new Set(["existing"]));

    expect(result.recoveredJobs.map((job) => job.id)).toEqual(["variant", "canonical", "every"]);
    expect(result.recoveredJobs[0]).toMatchObject({
      schedule: { kind: "cron" },
      state: { nextRunAtMs: 123 },
      updatedAtMs: 456,
    });
    expect(result.retainedEntries.map((entry) => entry.sourceIndex)).toEqual([2, 3, 4]);
  });

  const sourceSessionKey = "agent:main:dashboard:source";
  it.each([
    ["current", undefined, "isolated", undefined],
    ["current", " \t ", "isolated", undefined],
    ["current", 42, "isolated", undefined],
    [" CURRENT ", sourceSessionKey, "current", sourceSessionKey],
    [" ISOLATED ", sourceSessionKey, "isolated", sourceSessionKey],
    [" SESSION: ProjectAlpha ", sourceSessionKey, "session:ProjectAlpha", sourceSessionKey],
    [undefined, sourceSessionKey, "isolated", sourceSessionKey],
  ])(
    "normalizes target %s with binding %s without changing the rest of the job",
    (sessionTarget, sessionKey, target, binding) => {
      const job = {
        id: "session-target",
        name: "Session target",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        sessionTarget,
        sessionKey,
        owner: { agentId: "main", sessionKey: sourceSessionKey },
        schedule: { kind: "every", everyMs: 120_000, anchorMs: 1 },
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Report the result." },
        delivery: { mode: "announce" },
        trigger: { script: "return { fire: false };" },
        state: { consecutiveErrors: 2 },
      };
      const expected = { ...structuredClone(job), sessionTarget: target, sessionKey: binding };

      const result = normalizeStoredCronJobs([job]);

      expect(result.jobs).toEqual([expected]);
      expect(result.mutated).toBe(true);
      const canonical = normalizeStoredCronJobs(result.jobs);
      expect(canonical.mutated).toBe(false);
      expect(canonical.jobs).toEqual([expected]);
      expect(canonical.removedJobs).toEqual([]);
    },
  );
});
