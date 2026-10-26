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
const cron = (expr: string) => ({ kind: "cron", expr, tz: "UTC" });
const codexRuntime = { agentRuntime: { id: "codex" } };
const expectFields = (
  job: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(fields)) {
    expect(job?.[key]).toEqual(value);
  }
};

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

it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  [
    "payload provider",
    { payload: agentPayload({ provider: " Slack " }) },
    { payload: agentPayload(), delivery: { mode: "announce", channel: "slack" } },
  ],
  [
    "task-suggestion tool",
    {
      payload: agentPayload({
        toolsAllow: ["read", TASK_SUGGESTION_TOOL_NAME_MIGRATION.legacyName],
      }),
    },
    { payload: agentPayload({ toolsAllow: ["read", "suggest_task"] }) },
  ],
  [
    "image pattern",
    { payload: agentPayload({ toolsAllow: ["image*"] }) },
    { payload: agentPayload({ toolsAllow: ["image*", "view_image"] }) },
  ],
  [
    "systemEvent message",
    { payload: { kind: "systemEvent", message: "tick" } },
    { payload: { kind: "systemEvent", text: "tick" } },
  ],
  [
    "agentTurn casing",
    { sessionTarget: "isolated", payload: { kind: " agentTurn ", message: "ping" } },
    { payload: agentPayload() },
  ],
  [
    "systemEvent casing",
    { payload: { kind: "SYSTEMEVENT", text: "pong" } },
    { payload: { kind: "systemEvent", text: "pong" } },
  ],
  [
    "invalid stagger",
    { schedule: { ...cron("17 * * * *"), staggerMs: "bogus" } },
    { schedule: cron("17 * * * *") },
  ],
  [
    "stream schedule",
    { schedule: { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " } },
    { schedule: { kind: "stream", command: ["node", "events.mjs"], mode: "line" } },
  ],
])("normalizes %s", (_name, input, fields) => {
  const { job, result } = normalizeLegacy(input);
  expect(result).toMatchObject({ mutated: true, removedJobs: [] });
  expect(result.issues.invalidSchedule).toBeUndefined();
  expectFields(job, fields);
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
    "openai/gpt-5.6-sol": codexRuntime,
    "openai/gpt-5.4-mini": codexRuntime,
  });
  expect(
    resolveAgentHarnessPolicy({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      config: runtimeRepair.config,
    }).runtime,
  ).toBe("codex");
});

const explicitAgents: NonNullable<OpenClawConfigWithLegacyRoster["agents"]> = {
  ownership: "explicit",
  defaults: { systemAgent: { agentId: "ops" } },
  entries: { main: {}, ops: {} },
};
it.each<
  [string, NonNullable<OpenClawConfigWithLegacyRoster["agents"]>, string | undefined, string]
>([
  ["named list default", { list: [{ id: "primary", default: true }] }, "primary", "primary"],
  ["sole configured agent", { entries: { ops: {} } }, undefined, "ops"],
  ["configured system agent", explicitAgents, undefined, "ops"],
  ["explicit job owner before the system agent", explicitAgents, "main", "main"],
])("writes policy only to the %s", (_name, agents, agentId, expectedAgentId) => {
  const jobs = [codexJob({ agentId })];
  const targets = collectStoredCronCodexRuntimePolicyTargets(jobs);
  const repaired = repairCronCodexRuntimePolicies({ cfg: { agents }, targets });
  const owners = repaired.config.agents;
  const models = owners?.entries?.[expectedAgentId]?.models ?? owners?.list?.[0]?.models;
  expect(models).toEqual({ "openai/gpt-5.6-sol": codexRuntime });
  for (const [entryId, entry] of Object.entries(owners?.entries ?? {})) {
    if (entryId !== expectedAgentId) {
      expect(entry.models).toBeUndefined();
    }
  }
  expect(owners?.defaults?.models).toBeUndefined();
  expect(repaired.warnings).toEqual([]);
  const plan = planCronCodexRefRewriteAgainstPersistedConfig({ cfg: repaired.config, targets });
  expect(plan).toEqual({ warnings: [], blockedTargets: [] });
  normalizeWithPolicy(jobs, plan);
  expect(jobs[0]).toMatchObject({ agentId, payload: { model: "openai/gpt-5.6-sol" } });
});

it.each(["blocked namespace", "unpersisted policy", "conflicting runtime"] as const)(
  "retains legacy refs for %s",
  (reason) => {
    const cfg: OpenClawConfigWithLegacyRoster = {
      agents: {
        list: [
          {
            id: "primary",
            default: true,
            models:
              reason === "conflicting runtime"
                ? { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } }
                : {},
          },
        ],
      },
    };
    const payload = agentPayload({ model: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.3-mini"] });
    const jobs = [codexJob({ payload })];
    if (reason === "blocked namespace") {
      const repaired = repairCronCodexRuntimePolicies({
        cfg,
        targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
        blockedModelIdentities: new Set([
          expectDefined(legacyCodexProviderIdentityKey("codex"), "namespace"),
        ]),
      });
      expect(repaired.config.agents?.list?.[0]?.models).toEqual({});
      expect(repaired.config.agents?.defaults?.models).toBeUndefined();
    }
    const plan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg,
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
      blockedModelIdentities:
        reason === "blocked namespace"
          ? new Set([expectDefined(legacyCodexProviderIdentityKey("codex"), "namespace")])
          : undefined,
    });
    const result = normalizeWithPolicy(jobs, plan);
    if (reason !== "blocked namespace") {
      expect(plan.warnings.join("\n")).toContain(
        reason === "unpersisted policy"
          ? "policy is not present in persisted config"
          : 'Retained agents.list.primary.models.openai/gpt-5.6-sol.agentRuntime.id="openclaw"',
      );
    } else {
      expect(plan.warnings).toEqual([]);
    }
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toEqual([]);
    expect(jobs[0]?.payload).toEqual(
      agentPayload({ model: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.3-mini"] }),
    );
    expect(cfg.agents?.defaults?.models).toBeUndefined();
  },
);

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
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: `Command to run:\n- command: ${command}\n- workdir: /home/openclaw/.razor/quant\n- timeout: 840`,
      toolsAllow: ["group:runtime"],
      lightContext: true,
      timeoutSeconds: 900,
      model: "openai/gpt-5.5",
      deliver: true,
      channel: "telegram",
      to: "123",
    },
  });

  expect(result.issues.legacyAgentTurnCommandPayload).toBe(1);
  expectFields(job, {
    delivery: { mode: "announce", channel: "telegram", to: "123" },
    payload: {
      kind: "command",
      argv: ["sh", "-lc", command],
      cwd: "/home/openclaw/.razor/quant",
      timeoutSeconds: 900,
    },
  });
});

// The restricted-command no-conversion path is covered through Doctor by
// index.test.ts: "keeps restricted command prompts actionable without a --fix repair note".
it.each([
  { field: "schedule", issue: "invalidSchedule", values: [{ kind: "cron", expr: [] }, undefined] },
  {
    field: "payload",
    issue: "invalidPayload",
    values: [
      { kind: "agentTurn", message: ["tick"] },
      undefined,
      { kind: "systemEvent" },
      { kind: "command", command: "echo daily" },
      { kind: "agentmessage", message: "summarize" },
    ],
  },
] as const)(
  "quarantines invalid $field rows without removing a valid sibling",
  ({ field, issue, values }) => {
    const result = normalizeStoredCronJobs([
      makeLegacyJob({ id: "valid" }),
      ...values.map((value) => makeLegacyJob({ [field]: value })),
    ]);
    expect(result.jobs.map((job) => job.id)).toEqual(["valid"]);
    expect(result.issues[issue]).toBe(values.length);
  },
);

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
  expectFields(job, {
    sessionKey: "agent:main:discord:channel:ops",
    schedule: { kind: "at", at: new Date(1_700_000_000_000).toISOString() },
    delivery: { mode: "announce", channel: "telegram", to: "7200373102", bestEffort: true },
    isolation: undefined,
    payload: { kind: "agentTurn", message: "hi" },
  });
  expect("isolation" in expectDefined(job, "job test invariant")).toBe(false);
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

it("recovers only currently valid schedule rows and preserves recovery state", () => {
  // Ordinary schedule recovery is covered through Doctor in index.test.ts.
  const stream = { kind: "sandbox-stream", command: ["watch-source"] };
  const inputs: [string, Record<string, unknown>][] = [
    ["existing", cron("0 8 * * *")],
    ["other-reason", cron("0 9 * * *")],
    ["sandbox", stream],
    ["missing-target", stream],
    ["unknown", { kind: "daily", at: "09:00" }],
  ];
  const entries: QuarantinedCronConfigJob[] = inputs.map(([id, schedule], sourceIndex) => ({
    sourceIndex,
    reason: id === "other-reason" ? "missing-payload" : "invalid-schedule",
    job: makeLegacyJob({
      id,
      schedule,
      ...(id === "sandbox" ? { streamSandbox: makeCronStreamSandboxTarget() } : {}),
    }),
    state: { nextRunAtMs: 123 },
    updatedAtMs: 456,
  }));
  const result = recoverValidQuarantinedCronScheduleJobs(entries, new Set(["existing"]));
  expect(result.recoveredJobs).toMatchObject([
    {
      id: "sandbox",
      schedule: { kind: "stream", command: ["watch-source"] },
      streamSandbox: makeCronStreamSandboxTarget(),
      state: { nextRunAtMs: 123 },
      updatedAtMs: 456,
    },
  ]);
  expect(entries[2]?.job).toMatchObject({ schedule: { kind: "sandbox-stream" } });
  expect(result.retainedEntries.map((entry) => entry.sourceIndex)).toEqual([0, 1, 3, 4]);
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
    const job = makeLegacyJob({
      id: "session-target",
      description: undefined,
      enabled: false,
      sessionTarget,
      sessionKey,
      owner: { agentId: "main", sessionKey: sourceSessionKey },
      payload: agentPayload(),
      delivery: { mode: "announce" },
      trigger: { script: "return { fire: false };" },
      state: { consecutiveErrors: 2 },
    });
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
