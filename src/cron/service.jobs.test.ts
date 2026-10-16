import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { normalizeCronJobPatch } from "./normalize.js";
import { DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS } from "./script-payload.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import {
  computeJobNextRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  nextWakeAtMs,
  recomputeSingleJobForMaintenance,
} from "./service/jobs-scheduling.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.test-support.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const WEBHOOK = "https://example.invalid/cron";
function input(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    ...overrides,
  };
}

type AgentPayload = Extract<CronJob["payload"], { kind: "agentTurn" }>;
const agentPayload = (overrides: Partial<AgentPayload> = {}): AgentPayload => ({
  kind: "agentTurn",
  message: "do it",
  ...overrides,
});

function agentInput(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return input({
    sessionTarget: "isolated",
    payload: agentPayload(),
    ...overrides,
  });
}

function fixtureJob(overrides: Partial<CronJob> = {}): CronJob {
  return { ...input(), id: "job", createdAtMs: NOW, updatedAtMs: NOW, state: {}, ...overrides };
}

function agentJob(delivery?: CronJob["delivery"], overrides: Partial<CronJob> = {}): CronJob {
  return fixtureJob({ ...agentInput(), delivery, ...overrides });
}

function fixtureState(defaultAgentId?: string): CronServiceState {
  return { deps: { nowMs: () => NOW, defaultAgentId } } as unknown as CronServiceState;
}

const createTestJob = (jobInput = input(), opts?: Parameters<typeof createJob>[2]) =>
  createJob(fixtureState(), jobInput, opts);

const scheduledJob = (schedule: CronJob["schedule"]) => createTestJob(input({ schedule }));

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

it("rejects completion webhooks on disabled delivery", () => {
  expect(() =>
    applyJobPatch(agentJob({ mode: "announce" }), {
      delivery: { mode: "none", completionDestination: { mode: "webhook", to: WEBHOOK } },
    }),
  ).toThrow('cron completion destination webhook is only supported with delivery.mode="announce"');
});

it("normalizes delivery overrides and preserves the account until explicitly cleared", () => {
  const current = agentJob(
    { mode: "announce", channel: "signal", to: "123" },
    {
      sessionTarget: "session:project-alpha",
    },
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

it("rejects an empty webhook target", () => {
  expect(() =>
    applyJobPatch(fixtureJob({ delivery: { mode: "webhook" } }), {
      delivery: { mode: "webhook", to: "" },
    }),
  ).toThrow("cron webhook delivery requires delivery.to to be a valid http(s) URL");
});

it("rejects failure destinations on existing non-webhook main jobs", () => {
  const current = fixtureJob({
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: { mode: "announce", channel: "telegram", to: "999" },
    },
  });
  expect(() => applyJobPatch(current, { enabled: true })).toThrow(
    'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
  );
});

it("validates and trims webhook failure destinations", () => {
  const failureDestination = { mode: "webhook" as const, to: "not-a-url" };
  const current = agentJob({
    mode: "announce",
    channel: "telegram",
    to: "123",
    failureDestination,
  });
  expect(() => applyJobPatch(current, { enabled: true })).toThrow(
    "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL",
  );
  failureDestination.to = `  ${WEBHOOK}  `;
  applyJobPatch(current, { enabled: true });
  expect(current.delivery?.failureDestination?.to).toBe(WEBHOOK);
});

const authoredSettings = {
  lightContext: true,
  model: "openai/gpt-5",
  fallbacks: ["anthropic/claude-haiku-3-5"],
  thinking: "low",
  toolsAllow: ["read", "write"],
};
const replacementPayload = agentPayload({
  message: "hello",
  lightContext: true,
  fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
  toolsAllow: ["exec", "read"],
  toolsAllowIsDefault: true,
}) satisfies CronJobCreate["payload"];
const customSession = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
it.each<
  [string, () => CronJob, CronJobPatch["payload"], CronJob["payload"], CronJob["sessionTarget"]?]
>([
  [
    "updates authored agent settings",
    () => agentJob(),
    { kind: "agentTurn", ...authoredSettings },
    agentPayload({ ...authoredSettings }),
  ],
  [
    "replaces a system payload with agent settings and default authority",
    () => fixtureJob(),
    replacementPayload,
    replacementPayload,
    customSession,
  ],
  [
    "clears model-selection overrides without changing the message",
    () =>
      agentJob(undefined, {
        payload: agentPayload({
          model: "openai/gpt-5",
          thinking: "high",
          fallbacks: ["openrouter/gpt-4.1-mini"],
        }),
      }),
    { kind: "agentTurn", model: null, thinking: null, fallbacks: null },
    agentPayload(),
  ],
])("%s", (_name, makeJob, payload, expectedPayload, sessionTarget) => {
  const current = makeJob();
  const expected = structuredClone(expectedPayload);
  applyJobPatch(current, { payload, ...(sessionTarget ? { sessionTarget } : {}) });
  expect(current.payload).toEqual(expected);
  if (sessionTarget) {
    expect(current.sessionTarget).toBe(sessionTarget);
  }
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

it("rejects overflowing intervals while preserving the inclusive Date boundary", () => {
  expect(() => scheduledJob({ kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS })).toThrow(
    "cron every schedule has no upcoming run time and would never fire",
  );
  expect(
    scheduledJob({ kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 }).state.nextRunAtMs,
  ).toBe(MAX_DATE_TIMESTAMP_MS);
});

it("rejects invalid one-shot timestamps at the service boundary", () => {
  expect(
    scheduledJob({ kind: "at", at: new Date(MAX_DATE_TIMESTAMP_MS).toISOString() }).state
      .nextRunAtMs,
  ).toBe(MAX_DATE_TIMESTAMP_MS);
  expect(() => scheduledJob({ kind: "at", at: String(MAX_DATE_TIMESTAMP_MS + 1) })).toThrow(
    "Date-valid absolute timestamp",
  );
});

const configuredChannels = ["reef", "discord"];
const options = { configuredChannels };
const explicitDelivery = () => agentInput({ delivery: { mode: "announce", channel: "discord" } });

it("revalidates patches that change delivery resolution", () => {
  const current = createTestJob(explicitDelivery(), options);
  expect(() => applyJobPatch(current, { delivery: { channel: "last" } }, options)).toThrow(
    "cron announce delivery requires an explicit channel",
  );
});

it("preserves explicit empty caps and leaves transport-only jobs capless", () => {
  const noTools = createTestJob(
    agentInput({
      sessionTarget: "session:project-alpha",
      payload: agentPayload({ message: "render", toolsAllow: [] }),
    }),
  );
  const transportOnly = createTestJob(input());
  expect(noTools.payload.toolsAllow).toEqual([]);
  expect(transportOnly.payload.toolsAllow).toBeUndefined();
});

it("preserves legacy and explicit authority during declarative convergence", () => {
  const legacy = agentJob({ mode: "none" });
  const explicit = agentJob(
    { mode: "none" },
    {
      payload: agentPayload({
        message: "explicit",
        toolsAllow: ["read", "cron"],
        toolsAllowIsDefault: true,
      }),
    },
  );
  const declaration = agentInput({
    payload: agentPayload({ message: "updated" }),
    delivery: { mode: "none" },
  });
  applyDeclarativeJobSpec(legacy, declaration, convergence);
  applyDeclarativeJobSpec(explicit, declaration, convergence);
  expect(legacy.payload.toolsAllow).toBeUndefined();
  expect(explicit.payload).toMatchObject({
    toolsAllow: ["read", "cron"],
    toolsAllowIsDefault: true,
  });
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

it("rejects malformed trigger scripts on patch", () => {
  const mutate = (script: string) => {
    const current = createTestJob(triggeredInput());
    return applyJobPatch(current, { trigger: { script } });
  };
  expect(() => mutate(malformedScript)).toThrow(
    "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
  );
  expect(() => mutate("   ")).toThrow("cron trigger script must not be empty");
});

it("allows removal of a legacy malformed trigger", () => {
  const current = createTestJob(triggeredInput());
  current.trigger = { script: malformedScript };
  applyJobPatch(current, { trigger: null }, { cronConfig: { triggers: { enabled: false } } });
  expect(current.trigger).toBeUndefined();
});

const scriptInput = () =>
  input({
    sessionTarget: "isolated",
    payload: {
      kind: "script",
      script: "return { state: { count: 1 } }",
      timeoutSeconds: 4_000,
      toolBudget: 4_000,
    },
  });
const enabled = { cronConfig: { triggers: { enabled: true } } };

it("rejects malformed scripts on patch", () => {
  const current = createTestJob(scriptInput());
  expect(() =>
    applyJobPatch(current, { payload: { kind: "script", script: "const x = ;" } }, enabled),
  ).toThrow("cron script payload has a syntax error");
});

it("rejects condition triggers because both script kinds own trigger.state", () => {
  const serviceState = fixtureState();
  expect(() =>
    createJob(serviceState, { ...scriptInput(), trigger: { script: "return { fire: true }" } }),
  ).toThrow("cannot be combined with a condition trigger");
  expect(() =>
    applyJobPatch(
      createJob(serviceState, scriptInput()),
      { trigger: { script: "return { fire: true }" } },
      enabled,
    ),
  ).toThrow("cannot be combined with a condition trigger");
});

it("rejects conversion to script while disabled and caps an enabled conversion", () => {
  const base = createTestJob(agentInput());
  expect(() =>
    applyJobPatch(
      structuredClone(base),
      { payload: { kind: "script", script: "return {}" } },
      {
        cronConfig: { triggers: { enabled: false } },
      },
    ),
  ).toThrow("the operator set cron.triggers.enabled: false");
  applyJobPatch(
    base,
    {
      payload: { kind: "script", script: "return {}", timeoutSeconds: 9_000, toolBudget: 9_000 },
    },
    enabled,
  );
  expect(base.payload).toMatchObject({ kind: "script", timeoutSeconds: 900, toolBudget: 200 });
});

it("rejects null bytes in custom session targets", () => {
  expect(() => createTestJob(agentInput({ sessionTarget: "session:bad\0id" }))).toThrow(
    "invalid cron sessionTarget session id",
  );
});

it("rejects patching a main-session job to a non-default agent", () => {
  expect(() =>
    applyJobPatch(fixtureJob(), { agentId: "custom-agent" }, { defaultAgentId: "main" }),
  ).toThrow('cron: sessionTarget "main" is only valid for the default agent');
});

const hourly: CronJob["schedule"] = {
  kind: "cron",
  expr: "0 * * * *",
  tz: "UTC",
  staggerMs: 120_000,
};
it("treats missing enabled as enabled for legacy wake selection", () => {
  const serviceState = fixtureState();
  serviceState.store = {
    version: 1,
    jobs: [
      fixtureJob({
        enabled: undefined as unknown as boolean,
        schedule: { kind: "at", at: new Date(NOW + 60_000).toISOString() },
        state: { nextRunAtMs: NOW + 60_000 },
      }),
    ],
  };
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
    name: "test job",
    payload: { kind: "systemEvent", text: "test" },
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    wakeMode: "next-heartbeat",
    state: statePatch,
  });
  return { job, state: createMockCronStateForJobs({ jobs: [job], nowMs: NOW }) };
}

it("leaves a queued marker from before a clock rollback for startup recovery", () => {
  const futureQueuedAt = NOW + 3 * 60 * 60_000;
  const { job, state } = maintenanceFixture({
    nextRunAtMs: NOW + 60_000,
    queuedAtMs: futureQueuedAt,
  });
  recomputeSingleJobForMaintenance(
    state,
    job,
    { deferredNotifications: [] },
    { reservations: new Map(), isJobActive: () => false },
  );

  expect(job.state.queuedAtMs).toBe(futureQueuedAt);
  expect(job.state.nextRunAtMs).toBe(NOW + 60_000);
});

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

it("leaves an overdue running marker and its deadline for startup recovery", () => {
  const pastDue = NOW - 60_000;
  const staleRunningAt = NOW - 3 * 60 * 60_000;
  const { job, state } = maintenanceFixture({
    nextRunAtMs: pastDue,
    runningAtMs: staleRunningAt,
    lastRunAtMs: pastDue + 1000,
  });
  recomputeSingleJobForMaintenance(
    state,
    job,
    { deferredNotifications: [], recomputeExpired: true, nowMs: NOW },
    { reservations: new Map(), isJobActive: () => false },
  );

  expect(job.state.runningAtMs).toBe(staleRunningAt);
  expect(job.state.nextRunAtMs).toBe(pastDue);
});
