import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { makeCronStreamSandboxTarget } from "../../../cron/stream-sandbox.test-support.js";
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
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
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
  return { job: jobs[0], result };
}

const normalizeLegacy = (overrides: Record<string, unknown>) =>
  normalizeOneJob(makeLegacyJob(overrides));

const every = { kind: "every", everyMs: 60_000 };
const agentPayload = (fields: Record<string, unknown> = {}) => ({
  kind: "agentTurn",
  message: "ping",
  ...fields,
});
const codexJob = (overrides: Record<string, unknown> = {}) =>
  makeLegacyJob({
    schedule: { ...every },
    payload: agentPayload({ model: "codex/gpt-5.6-sol" }),
    ...overrides,
  });

function normalizeWithPolicy(
  jobs: Record<string, unknown>[],
  plan: { blockedTargets: Parameters<typeof cronCodexRuntimePolicyTargetKey>[0][] },
) {
  const blocked = new Set(plan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));
  return normalizeStoredCronJobs(jobs, {
    migrateCodexModelRefs: true,
    shouldMigrateCodexRuntimePolicyTarget: (target) =>
      !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
  });
}

it("normalizes legacy cron fields and reports migration issues", () => {
  const { job, result } = normalizeOneJob({
    jobId: "legacy-job",
    schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
    message: "say hi",
    model: "openai/gpt-5.5",
    deliver: true,
    provider: " TeLeGrAm ",
    to: "12345",
    threadId: " 77 ",
  });
  expect(result).toMatchObject({
    mutated: true,
    issues: {
      jobId: 1,
      legacyScheduleCron: 1,
      legacyTopLevelPayloadFields: 1,
      legacyTopLevelDeliveryFields: 1,
    },
  });
  expect(job).toMatchObject({
    id: "legacy-job",
    schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    delivery: { mode: "announce", channel: "telegram", to: "12345", threadId: "77" },
    payload: { kind: "agentTurn", message: "say hi", model: "openai/gpt-5.5" },
  });
  expect([job?.jobId, job?.message, job?.provider]).toEqual([undefined, undefined, undefined]);
});

it("normalizes payload provider alias into channel", () => {
  const { job, result } = normalizeOneJob({
    id: "legacy-provider",
    schedule: { ...every },
    payload: agentPayload({ provider: " Slack " }),
  });
  expect(result).toMatchObject({ mutated: true, issues: { legacyPayloadProvider: 1 } });
  expect(job?.payload).toEqual({ kind: "agentTurn", message: "ping" });
  expect(job?.delivery).toEqual({ mode: "announce", channel: "slack" });
});

it("rewrites the legacy task-suggestion tool in persisted tool allowlists", () => {
  const { job, result } = normalizeLegacy({
    schedule: { kind: "every", everyMs: 60_000 },
    payload: agentPayload({
      toolsAllow: ["read", TASK_SUGGESTION_TOOL_NAME_MIGRATION.legacyName],
    }),
  });

  expect(result).toMatchObject({ mutated: true, issues: { legacyTaskSuggestionToolName: 1 } });
  expect(job?.payload).toMatchObject({ toolsAllow: ["read", "suggest_task"] });
});

it("migrates the legacy image inspection pattern", () => {
  const { job, result } = normalizeLegacy({
    schedule: { kind: "every", everyMs: 60_000 },
    payload: agentPayload({ toolsAllow: ["image*"] }),
  });

  expect(result.issues.legacyImageInspectionToolName).toBe(1);
  expect(job?.payload).toMatchObject({ toolsAllow: ["image*", "view_image"] });
});

it("rewrites shipped codex model refs in cron payloads", () => {
  const { job, result } = normalizeOneJob(
    codexJob({
      id: "shipped-codex-cron-model",
      payload: agentPayload({ model: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.4-mini"] }),
    }),
    { migrateCodexModelRefs: true },
  );

  expect(result).toMatchObject({ mutated: true, issues: { legacyPayloadCodexModel: 1 } });
  expect(job?.payload).toMatchObject({
    model: "openai/gpt-5.6-sol",
    fallbacks: ["openai/gpt-5.4-mini"],
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
  const jobs = [
    codexJob({
      id: "provider-conflicted-codex-model",
      payload: agentPayload({ model: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.3-mini"] }),
    }),
  ];
  const blockedNamespace = expectDefined(
    legacyCodexProviderIdentityKey("codex"),
    "blocked cron namespace test invariant",
  );
  const policyPlan = repairCronCodexRuntimePolicies({
    cfg: {},
    targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    blockedModelIdentities: new Set([blockedNamespace]),
  });
  normalizeWithPolicy(jobs, policyPlan);

  expect(jobs[0]?.payload).toMatchObject({
    model: "codex/gpt-5.6-sol",
    fallbacks: ["codex/gpt-5.3-mini"],
  });
  expect(policyPlan.config.agents?.defaults?.models).toBeUndefined();
});

it("retains a default-agent cron ref when its list-entry runtime conflicts", () => {
  const jobs = [codexJob({ id: "default-agent-shadowed-codex-model" })];
  const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
    cfg: {
      agents: {
        list: [
          {
            id: "primary",
            default: true,
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    },
    targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
  });
  normalizeWithPolicy(jobs, rewritePlan);

  expect(rewritePlan.warnings.join("\n")).toContain(
    'Retained agents.list.primary.models.openai/gpt-5.6-sol.agentRuntime.id="openclaw"',
  );
  expect(jobs[0]?.payload).toMatchObject({ model: "codex/gpt-5.6-sol" });
});

it("writes a named default agent policy to its list entry before rewriting cron", () => {
  const jobs = [codexJob({ id: "default-agent-list-codex-model", agentId: "primary" })];
  const targets = collectStoredCronCodexRuntimePolicyTargets(jobs);
  const policyRepair = repairCronCodexRuntimePolicies({
    cfg: {
      agents: {
        list: [{ id: "primary", default: true }],
      },
    },
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
  normalizeWithPolicy(jobs, rewritePlan);
  expect(jobs[0]?.payload).toMatchObject({ model: "openai/gpt-5.6-sol" });
});

const explicitAgents = (): NonNullable<OpenClawConfigWithLegacyRoster["agents"]> => ({
  ownership: "explicit",
  defaults: { systemAgent: { agentId: "ops" } },
  entries: { main: {}, ops: {} },
});
it.each<
  [string, NonNullable<OpenClawConfigWithLegacyRoster["agents"]>, string | undefined, string]
>([
  ["sole configured agent", { entries: { ops: {} } }, undefined, "ops"],
  ["configured system agent under explicit ownership", explicitAgents(), undefined, "ops"],
  ["explicit job owner before the configured system agent", explicitAgents(), "main", "main"],
])("writes policy only to the %s", (_name, agents, agentId, expectedAgentId) => {
  const jobs = [codexJob({ id: "implicit-default-codex-model", agentId })];
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
  const jobs = [codexJob({ id: "post-snapshot-codex-cron-model" })];
  const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
    cfg: { agents: { entries: { main: { default: true } } } },
    targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
  });
  const result = normalizeWithPolicy(jobs, rewritePlan);

  expect(rewritePlan.warnings).toEqual([
    expect.stringContaining("policy is not present in persisted config"),
  ]);
  expect(result.issues.legacyPayloadCodexModel).toBe(1);
  expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
  expect(jobs[0]?.payload).toMatchObject({ model: "codex/gpt-5.6-sol" });
});

it("does not rewrite Codex refs during an ordinary cron normalization pass", () => {
  const { job, result } = normalizeOneJob(codexJob({ id: "deferred-codex-cron-model" }));

  expect(result.issues.legacyPayloadCodexModel).toBe(1);
  expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
  expect(job?.payload).toMatchObject({ model: "codex/gpt-5.6-sol" });
});

it("converts legacy agent command prompts into command cron payloads", () => {
  const command =
    "cd /home/openclaw/.razor/quant && ./scripts/system/run_position_control.sh --write-card --silent-token NO_REPLY";
  const { job, result } = normalizeLegacy({
    id: "quant-position-card",
    schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: [
        "Run this deterministic shell job once and report only the final JSON/status.",
        "",
        "Command to run:",
        `- command: ${command}`,
        "- workdir: /home/openclaw/.razor/quant",
        "- background: false",
        "- timeout: 840",
        "",
        "Final response contract:",
        "- If the command prints exactly NO_REPLY, respond exactly NO_REPLY.",
        "- Otherwise return the concise command output.",
      ].join("\n"),
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
  expect(expectDefined(job, "job test invariant").delivery).toEqual({
    mode: "announce",
    channel: "telegram",
    to: "123",
  });
  const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
  expect(payload).toEqual({
    kind: "command",
    argv: ["sh", "-lc", command],
    cwd: "/home/openclaw/.razor/quant",
    timeoutSeconds: 900,
  });
});

it("does not convert command-shaped prompts without shell tool access", () => {
  const command = "python3 scripts/check_mail.py";
  const { job, result } = normalizeLegacy({
    id: "restricted-command-prompt",
    schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: [
        "Command to run:",
        `- command: ${command}`,
        "- workdir: /home/openclaw/.razor/clawd",
      ].join("\n"),
      toolsAllow: ["read", "message"],
    },
  });

  expect(result.issues.legacyAgentTurnCommandPayload).toBeUndefined();
  expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
  expect(result.unresolvedAgentTurnCommandPromptJobs).toEqual(["Legacy job"]);
  expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual([]);
  const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
  expect(payload.kind).toBe("agentTurn");
  expect(payload.message).toContain(command);
  expect(payload.toolsAllow).toEqual(["read", "message"]);
});

it("rewrites legacy systemEvent message payloads to text", () => {
  const jobs = [
    makeLegacyJob({
      id: "legacy-system-event-message",
      payload: { kind: "systemEvent", message: "tick" },
    }),
  ];

  const result = normalizeStoredCronJobs(jobs);

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
  const job = (id: string, sessionTarget: string, payload: Record<string, unknown>) => ({
    id,
    name: "normalized",
    enabled: true,
    wakeMode: "now",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    payload,
    sessionTarget,
    delivery: { mode: "announce" },
    state: {},
  });
  const jobs = [
    job("spaced-agent-turn", "isolated", { kind: " agentTurn ", message: "ping" }),
    job("upper-system-event", "main", { kind: "SYSTEMEVENT", text: "pong" }),
  ];
  const result = normalizeStoredCronJobs(jobs);

  expect(result.mutated).toBe(true);
  expect(result.issues.legacyPayloadKind).toBe(2);
  expect(jobs.map(({ payload }) => payload)).toEqual([
    { kind: "agentTurn", message: "ping" },
    { kind: "systemEvent", text: "pong" },
  ]);
});

it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
  const { job, result } = normalizeLegacy({
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
  expect(job).toMatchObject({
    sessionKey: "agent:main:discord:channel:ops",
    schedule: { kind: "at", at: new Date(1_700_000_000_000).toISOString() },
  });
  expect(job?.delivery).toEqual({
    mode: "announce",
    channel: "telegram",
    to: "7200373102",
    bestEffort: true,
  });
  expect("isolation" in expectDefined(job, "job test invariant")).toBe(false);
  const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
  for (const key of ["deliver", "channel", "to", "bestEffortDeliver"]) {
    expect(payload[key]).toBeUndefined();
  }
  const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
  expect(schedule.atMs).toBeUndefined();
});

const at = "2026-04-01T10:00:00.000Z";
it.each([
  { at: "2026-04-01T12:00:00+02:00" },
  { at, atMs: undefined },
  { at: "2026-04-01T11:00:00.000Z", atMs: 1_775_037_600_000 },
  { at, atMs: 8_700_000_000_000_000 },
  { at: undefined, atMs: 8_700_000_000_000_000 },
])("normalizes or rejects a one-shot schedule: %j", (fields) => {
  const invalid = fields.at === undefined;
  const jobs = [makeLegacyJob({ description: undefined, schedule: { kind: "at", ...fields } })];
  const result = normalizeStoredCronJobs(jobs);
  expect(result.mutated).toBe(true);
  expect(result.issues.invalidSchedule).toBe(invalid ? 1 : undefined);
  if (invalid) {
    expect(jobs[0]).toBeUndefined();
  } else {
    expect(jobs[0]?.schedule).toEqual({ kind: "at", at });
    expect(normalizeStoredCronJobs(jobs).mutated).toBe(false);
  }
});

it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
  const { job } = normalizeLegacy({
    id: "job-cron-minute-legacy",
    name: "Legacy minute cron",
    schedule: {
      kind: "cron",
      expr: "17 * * * *",
      tz: "UTC",
      staggerMs: "bogus",
    },
  });

  const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
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
  expect(job?.payload).toEqual({ kind: "systemEvent", text: "bash /tmp/imessage-refresh.sh" });
  for (const key of ["command", "timeout"]) {
    expect(key in expectDefined(job, "job")).toBe(false);
  }
});

it("canonicalizes a recognized stream schedule and its mode", () => {
  const jobs = [
    makeLegacyJob({
      schedule: { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " },
    }),
  ];
  const result = normalizeStoredCronJobs(jobs);
  const job = expectDefined(jobs[0], "job test invariant");

  expect(result.removedJobs).toEqual([]);
  expect(result.issues.invalidSchedule).toBeUndefined();
  expect(job.schedule).toEqual({ kind: "stream", command: ["node", "events.mjs"], mode: "line" });
});

it("recovers only currently valid schedule rows and preserves recovery state", () => {
  const makeEntry = (
    id: string,
    schedule: Record<string, unknown>,
    jobFields: Record<string, unknown> = {},
    overrides: Partial<QuarantinedCronConfigJob> = {},
  ) => ({
    reason: "invalid-schedule",
    job: makeLegacyJob({ id, name: id, schedule, ...jobFields }),
    ...overrides,
  });
  const entries: QuarantinedCronConfigJob[] = [
    makeEntry(
      "variant",
      { kind: " CRON ", expr: "0 7 * * *" },
      {},
      {
        state: { nextRunAtMs: 123 },
        updatedAtMs: 456,
      },
    ),
    makeEntry("canonical", { kind: "every", everyMs: 60_000, anchorMs: 1 }),
    makeEntry("unknown", { kind: "daily", at: "09:00" }),
    makeEntry("existing", { kind: "cron", expr: "0 8 * * *" }),
    makeEntry(
      "other-reason",
      { kind: "cron", expr: "0 9 * * *" },
      {},
      { reason: "missing-payload" },
    ),
    makeEntry(
      "sandbox",
      { kind: "sandbox-stream", command: ["watch-source"] },
      {
        streamSandbox: makeCronStreamSandboxTarget(),
      },
    ),
    makeEntry("missing-target", { kind: "sandbox-stream", command: ["watch-source"] }),
  ].map((entry, sourceIndex) => Object.assign(entry, { sourceIndex }));

  const result = recoverValidQuarantinedCronScheduleJobs(entries, new Set(["existing"]));

  expect(result.recoveredJobs.map((job) => job.id)).toEqual(["variant", "canonical", "sandbox"]);
  expect(result.recoveredJobs[0]).toMatchObject({
    schedule: { kind: "cron" },
    state: { nextRunAtMs: 123 },
    updatedAtMs: 456,
  });
  expect(result.recoveredJobs[2]).toMatchObject({
    schedule: { kind: "stream", command: ["watch-source"] },
    streamSandbox: makeCronStreamSandboxTarget(),
  });
  expect(entries[5]?.job).toMatchObject({ schedule: { kind: "sandbox-stream" } });
  expect(result.retainedEntries.map((entry) => entry.sourceIndex)).toEqual([2, 3, 4, 6]);
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
    const expected = {
      ...structuredClone(job),
      sessionTarget: target,
      sessionKey: binding,
    };

    const result = normalizeStoredCronJobs([job]);

    expect(result.jobs).toEqual([expected]);
    expect(result.mutated).toBe(true);
    const canonical = normalizeStoredCronJobs(result.jobs);
    expect(canonical.mutated).toBe(false);
    expect(canonical.jobs).toEqual([expected]);
    expect(canonical.removedJobs).toEqual([]);
  },
);
