import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { normalizeCronJobPatch } from "./normalize.js";
import { DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS } from "./script-payload.js";
import { cronTestInput, cronTestJob } from "./service.fixture-builders.test-support.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import {
  computeJobNextRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  nextWakeAtMs,
  recomputeSingleJobForMaintenance,
} from "./service/jobs-scheduling.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.test-support.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "./service/jobs.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const WEBHOOK = "https://example.invalid/cron";
const input = (overrides: Partial<CronJobCreate> = {}) =>
  cronTestInput({
    name: "job",
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    ...overrides,
  });

type AgentPayload = Extract<CronJob["payload"], { kind: "agentTurn" }>;
const agentPayload = (overrides: Partial<AgentPayload> = {}): AgentPayload => ({
  kind: "agentTurn",
  message: "do it",
  ...overrides,
});

const agentInput = (overrides: Partial<CronJobCreate> = {}) =>
  input({ sessionTarget: "isolated", payload: agentPayload(), ...overrides });

const fixtureJob = (overrides: Partial<CronJob> = {}) =>
  cronTestJob({ ...input(), id: "job", createdAtMs: NOW, updatedAtMs: NOW, ...overrides });

const agentJob = (delivery?: CronJob["delivery"], overrides: Partial<CronJob> = {}) =>
  fixtureJob({ ...agentInput(), delivery, ...overrides });

const createTestJob = (jobInput = input(), opts?: Parameters<typeof createJob>[2]) =>
  createJob({ deps: { nowMs: () => NOW } }, jobInput, opts);

const convergence = { enabledExplicit: true, nowMs: NOW };

it.each([
  agentPayload({ message: "Synthetic reminder" }),
  { kind: "command", argv: ["printf", "synthetic-proof"] },
  { kind: "script", script: "return { output: 'synthetic-proof' };" },
] satisfies CronJob["payload"][])(
  "restores the default $kind timeout through a normalized update",
  (payload) => {
    const current = agentJob({ mode: "none" }, { payload: { ...payload, timeoutSeconds: 30 } });
    const patch = normalizeCronJobPatch({
      payload: { kind: payload.kind, timeoutSeconds: null },
    });
    if (!patch) {
      throw new Error("expected normalized patch");
    }
    applyJobPatch(current, patch);
    if (current.payload.kind === "script") {
      expect(current.payload.timeoutSeconds).toBe(DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS);
    } else {
      expect(current.payload).not.toHaveProperty("timeoutSeconds");
    }
  },
);

it("clears chat and completion routes when switching to a trimmed webhook", () => {
  const current = agentJob({
    mode: "announce",
    channel: "telegram",
    to: "-100123",
    threadId: 42,
    accountId: "coordinator",
    completionDestination: { mode: "webhook", to: WEBHOOK },
  });
  applyJobPatch(current, { delivery: { mode: "webhook", to: `  ${WEBHOOK}  ` } });
  expect(current.delivery).toEqual({ mode: "webhook", to: WEBHOOK });
});

it("clears a completion webhook explicitly", () => {
  const current = agentJob({
    mode: "announce",
    completionDestination: { mode: "webhook", to: WEBHOOK },
  });
  applyJobPatch(current, { delivery: { completionDestination: null } });
  expect(current.delivery?.mode).toBe("announce");
  expect(current.delivery?.completionDestination).toBeUndefined();
});

it("normalizes delivery overrides and preserves the account until explicitly cleared", () => {
  const current = agentJob(
    { ...announce, channel: "signal" },
    { sessionTarget: "session:project-alpha" },
  );
  applyJobPatch(current, {
    delivery: {
      channel: "telegram",
      to: "-10012345/6789",
      accountId: " coordinator ",
      bestEffort: true,
    },
  });
  expect(current.payload).toMatchObject(agentPayload());
  expect(current.delivery).toEqual({
    mode: "announce",
    channel: "telegram",
    to: "-10012345/6789",
    accountId: "coordinator",
    bestEffort: true,
  });
  applyJobPatch(current, { delivery: { to: "-100999" } });
  expect(current.delivery).toMatchObject({ accountId: "coordinator", to: "-100999" });
  applyJobPatch(current, { delivery: { accountId: "" } });
  expect(current.delivery?.accountId).toBeUndefined();
});

it("validates and trims webhook failure destinations", () => {
  const failureDestination = { mode: "webhook" as const, to: "not-a-url" };
  const current = agentJob({ ...announce, failureDestination });
  expect(() => applyJobPatch(current, { enabled: true })).toThrow(
    "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL",
  );
  failureDestination.to = `  ${WEBHOOK}  `;
  applyJobPatch(current, { enabled: true });
  expect(current.delivery?.failureDestination?.to).toBe(WEBHOOK);
});

it("preserves default tool authority when replacing a system payload", () => {
  const current = fixtureJob();
  const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
  const payload = agentPayload({
    message: "hello",
    toolsAllow: ["exec", "read"],
    toolsAllowIsDefault: true,
  });
  const expected = structuredClone(payload);
  applyJobPatch(current, { sessionTarget, payload });
  expect(current.sessionTarget).toBe(sessionTarget);
  expect(current.payload).toEqual(expected);
});

it("clears saved model-selection overrides without changing the message", () => {
  const current = agentJob(undefined, {
    payload: agentPayload({
      model: "openai/gpt-5",
      thinking: "high",
      fallbacks: ["openrouter/gpt-4.1-mini"],
    }),
  });
  applyJobPatch(current, {
    payload: { kind: "agentTurn", model: null, thinking: null, fallbacks: null },
  });
  expect(current.payload).toEqual(agentPayload());
});

type AgentPatch = Omit<
  Extract<NonNullable<CronJobPatch["payload"]>, { kind: "agentTurn" }>,
  "kind"
>;
it.each<[AgentPatch, string[], true | undefined]>([
  [{ toolsAllow: ["read"], toolsAllowIsDefault: true }, ["read"], undefined],
  [{ message: "later", toolsAllow: ["exec", "read"] }, ["exec", "read"], true],
  [{ toolsAllow: null }, ["*"], undefined],
])("preserves authority semantics for %j", (patch, toolsAllow, marker) => {
  const current = agentJob(undefined, {
    payload: agentPayload({ toolsAllow: ["exec", "read"], toolsAllowIsDefault: true }),
  });
  applyJobPatch(current, { payload: { kind: "agentTurn", ...patch } });
  expect([current.payload.toolsAllow, current.payload.toolsAllowIsDefault]).toEqual([
    toolsAllow,
    marker,
  ]);
});

const options = { configuredChannels: ["reef", "discord"] };

it("preserves explicit empty caps and leaves transport-only jobs capless", () => {
  const noTools = agentInput({
    sessionTarget: "session:project-alpha",
    payload: agentPayload({ toolsAllow: [] }),
  });
  expect(createTestJob(noTools).payload.toolsAllow).toEqual([]);
  expect(createTestJob().payload.toolsAllow).toBeUndefined();
});

it.each([undefined, { toolsAllow: ["read", "cron"], toolsAllowIsDefault: true }] satisfies Array<
  Pick<AgentPayload, "toolsAllow" | "toolsAllowIsDefault"> | undefined
>)("preserves declarative tool authority %j", (cap) => {
  const expected = structuredClone(cap);
  const current = agentJob(
    { mode: "none" },
    cap ? { payload: agentPayload({ ...cap, message: "explicit" }) } : {},
  );
  applyDeclarativeJobSpec(
    current,
    agentInput({ payload: agentPayload({ message: "updated" }), delivery: { mode: "none" } }),
    convergence,
  );
  expect(current.payload.toolsAllow).toEqual(expected?.toolsAllow);
  expect(current.payload.toolsAllowIsDefault).toBe(expected?.toolsAllowIsDefault);
});

it("adopts explicit authority when a declaration becomes tool-bearing", () => {
  const current = fixtureJob();
  applyDeclarativeJobSpec(current, input({ trigger: { script: "return true" } }), {
    ...convergence,
    cronConfig: { triggers: { enabled: true } },
  });
  expect(current.payload.toolsAllow).toEqual(["*"]);
});

const malformedScript = "const x = ;";
const triggeredInput = (script = "return { fire: true }") => input({ trigger: { script } });

it("allows removal of a legacy malformed trigger", () => {
  const current = createTestJob(triggeredInput());
  current.trigger = { script: malformedScript };
  applyJobPatch(current, { trigger: null }, { cronConfig: { triggers: { enabled: false } } });
  expect(current.trigger).toBeUndefined();
});

const scriptInput = () => agentInput({ payload: { kind: "script", script: "return {}" } });
const enabled = { cronConfig: { triggers: { enabled: true } } };

const hourly: CronJob["schedule"] = {
  kind: "cron",
  expr: "0 * * * *",
  tz: "UTC",
  staggerMs: 120_000,
};
it("treats missing enabled as enabled for legacy wake selection", () => {
  const serviceState = createMockCronStateForJobs({
    nowMs: NOW,
    jobs: [
      fixtureJob({
        enabled: undefined as unknown as boolean,
        schedule: { kind: "at", at: new Date(NOW + 60_000).toISOString() },
        state: { nextRunAtMs: NOW + 60_000 },
      }),
    ],
  });
  expect(nextWakeAtMs(serviceState)).toBe(NOW + 60_000);
});

it("derives fresh top-of-hour staggering when replacing an expression", () => {
  const current = fixtureJob({ schedule: hourly });
  applyJobPatch(current, { schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" } });
  expect(current.schedule).toEqual({ ...hourly, expr: "0 */2 * * *", staggerMs: 300_000 });
});

it("preserves explicit staggering when declarative convergence keeps the expression", () => {
  const current = createTestJob(input({ schedule: hourly }));
  applyDeclarativeJobSpec(
    current,
    input({ schedule: { kind: "cron", expr: "0 * * * *", tz: "America/Los_Angeles" } }),
    {
      ...convergence,
      enabledExplicit: false,
    },
  );
  expect(current.schedule).toEqual({ ...hourly, tz: "America/Los_Angeles" });
});

it("keeps a staggered slot in the current hour and includes its exact previous-run boundary", () => {
  const current = fixtureJob({
    id: "hourly-job-b",
    schedule: { kind: "cron", expr: "0 0 * * * *", tz: "UTC" },
  });
  const cursor = Date.parse("2026-02-06T10:01:00.000Z");
  const boundary = computeJobNextRunAtMs(current, cursor);
  expect(boundary).toBe(Date.parse("2026-02-06T10:00:00.000Z") + 117_612);
  expect(computeJobPreviousRunAtOrBeforeMs(current, boundary!)).toBe(boundary);
  expect(computeJobPreviousRunAtOrBeforeMs(current, boundary! + 500)).toBe(boundary);
});

function maintenanceFixture(statePatch: CronJob["state"]) {
  const job = fixtureJob({
    id: "test-job",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    wakeMode: "next-heartbeat",
    state: statePatch,
  });
  return { job, state: createMockCronStateForJobs({ jobs: [job], nowMs: NOW }) };
}

it("preserves a future running marker owned by a live execution", () => {
  const futureMarker = NOW + 3 * 60 * 60_000;
  const { job, state } = maintenanceFixture({
    nextRunAtMs: NOW + 60_000,
    runningAtMs: futureMarker,
  });
  const marker = markCronJobActive(job.id);
  try {
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
    expect(job.state.runningAtMs).toBe(futureMarker);
  } finally {
    clearCronJobActive(job.id, marker);
  }
});

const patchErrors = {
  completion: 'cron completion destination webhook is only supported with delivery.mode="announce"',
  webhook: "cron webhook delivery requires delivery.to to be a valid http(s) URL",
  mainFailure:
    'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
  triggerSyntax: "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
  emptyTrigger: "cron trigger script must not be empty",
  scriptSyntax: "cron script payload has a syntax error",
  triggerConflict: "cannot be combined with a condition trigger",
  disabledScript: "the operator set cron.triggers.enabled: false",
  channel: "cron announce delivery requires an explicit channel",
};
const announce = { mode: "announce" as const, channel: "telegram", to: "123" };
const invalidMainJob = () =>
  fixtureJob({
    delivery: { ...announce, failureDestination: { ...announce, to: "999" } },
  });
const explicitChannelJob = () =>
  createTestJob(agentInput({ delivery: { mode: "announce", channel: "discord" } }), options);
type InvalidPatch = [
  keyof typeof patchErrors,
  () => CronJob,
  CronJobPatch,
  Parameters<typeof applyJobPatch>[2]?,
];
it.each<InvalidPatch>([
  [
    "completion",
    () => agentJob({ mode: "announce" }),
    { delivery: { mode: "none", completionDestination: { mode: "webhook", to: WEBHOOK } } },
  ],
  [
    "webhook",
    () => fixtureJob({ delivery: { mode: "webhook" } }),
    { delivery: { mode: "webhook", to: "" } },
  ],
  ["mainFailure", invalidMainJob, { enabled: true }],
  [
    "triggerSyntax",
    () => createTestJob(triggeredInput()),
    { trigger: { script: malformedScript } },
  ],
  ["emptyTrigger", () => createTestJob(triggeredInput()), { trigger: { script: "   " } }],
  [
    "scriptSyntax",
    () => createTestJob(scriptInput()),
    { payload: { kind: "script", script: malformedScript } },
    enabled,
  ],
  [
    "triggerConflict",
    () => createTestJob(scriptInput()),
    { trigger: { script: "return { fire: true }" } },
    enabled,
  ],
  [
    "disabledScript",
    () => createTestJob(agentInput()),
    { payload: { kind: "script", script: "return {}" } },
    { cronConfig: { triggers: { enabled: false } } },
  ],
  ["channel", explicitChannelJob, { delivery: { channel: "last" } }, options],
])("rejects invalid %s patch", (error, makeJob, patch, opts) => {
  expect(() => applyJobPatch(makeJob(), patch, opts)).toThrow(patchErrors[error]);
});

const creationErrors = {
  interval: "cron every schedule has no upcoming run time and would never fire",
  timestamp: "Date-valid absolute timestamp",
  trigger: patchErrors.triggerConflict,
  session: "invalid cron sessionTarget session id",
};
it.each<[keyof typeof creationErrors, CronJobCreate]>([
  ["interval", input({ schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS } })],
  ["timestamp", input({ schedule: { kind: "at", at: String(MAX_DATE_TIMESTAMP_MS + 1) } })],
  ["trigger", { ...scriptInput(), trigger: { script: "return { fire: true }" } }],
  ["session", agentInput({ sessionTarget: "session:bad\0id" })],
])("rejects invalid %s at creation", (error, jobInput) => {
  expect(() => createTestJob(jobInput)).toThrow(creationErrors[error]);
});

it.each<CronJob["schedule"]>([
  { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 },
  { kind: "at", at: new Date(MAX_DATE_TIMESTAMP_MS).toISOString() },
])("accepts the inclusive Date boundary for $kind", (schedule) => {
  expect(createTestJob(input({ schedule })).state.nextRunAtMs).toBe(MAX_DATE_TIMESTAMP_MS);
});

it("caps enabled script conversions", () => {
  const current = createTestJob(agentInput());
  applyJobPatch(
    current,
    { payload: { kind: "script", script: "return {}", timeoutSeconds: 9_000, toolBudget: 9_000 } },
    enabled,
  );
  expect(current.payload).toMatchObject({ kind: "script", timeoutSeconds: 900, toolBudget: 200 });
});

it.each([
  ["queuedAtMs", NOW + 3 * 60 * 60_000, NOW + 60_000, false],
  ["runningAtMs", NOW - 3 * 60 * 60_000, NOW - 60_000, true],
] as const)(
  "leaves stale %s and its deadline for startup recovery",
  (field, marker, nextRunAtMs, overdue) => {
    const expected = { nextRunAtMs, [field]: marker };
    const { job, state } = maintenanceFixture({
      ...expected,
      ...(overdue ? { lastRunAtMs: nextRunAtMs + 1000 } : {}),
    });
    recomputeSingleJobForMaintenance(
      state,
      job,
      { deferredNotifications: [], ...(overdue ? { recomputeExpired: true, nowMs: NOW } : {}) },
      { reservations: new Map(), isJobActive: () => false },
    );
    expect(job.state).toMatchObject(expected);
  },
);

it.each(["systemEvent", "agentTurn"] as const)(
  "retains an explicit non-default agent for main-session %s jobs",
  (kind) => {
    const current = createTestJob(
      input({
        agentId: "custom-agent",
        payload: kind === "agentTurn" ? agentPayload() : { kind: "systemEvent", text: "tick" },
      }),
    );
    applyJobPatch(current, { name: "renamed" }, { defaultAgentId: "main" });
    expect(current).toMatchObject({
      agentId: "custom-agent",
      sessionTarget: "main",
      name: "renamed",
    });
  },
);
