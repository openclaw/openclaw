import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { normalizeCronJobPatch } from "./normalize.js";
import { DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS } from "./script-payload.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import {
  computeJobNextRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./service/jobs-scheduling.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "./service/jobs.js";
import { reserveQueuedCronRun } from "./service/run-admission.js";
import type { CronServiceState } from "./service/state.js";
import type { CronRunReceiptHandle } from "./store/run-receipt.types.js";
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

function agentInput(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return input({
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "do it" },
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

const convergence = { enabledExplicit: true, nowMs: NOW };

describe("applyJobPatch", () => {
  it.each([
    { kind: "agentTurn", message: "Synthetic reminder" },
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

  it("retargets announce delivery to main", () => {
    const current = agentJob({ mode: "announce", channel: "telegram", to: "123" });
    applyJobPatch(current, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    });
    expect(current.sessionTarget).toBe("main");
    expect(current.payload.kind).toBe("systemEvent");
    expect(current.delivery).toBeUndefined();
  });

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
    ).toThrow(
      'cron completion destination webhook is only supported with delivery.mode="announce"',
    );
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
    expect(current.payload).toMatchObject({ kind: "agentTurn", message: "do it" });
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
});

describe("agent payload patches", () => {
  it("updates authored agent settings in a single payload patch", () => {
    const current = agentJob();
    applyJobPatch(current, {
      payload: {
        kind: "agentTurn",
        lightContext: true,
        model: "openai/gpt-5",
        fallbacks: ["anthropic/claude-haiku-3-5"],
        thinking: "low",
        toolsAllow: ["read", "write"],
      },
    });
    expect(current.payload).toEqual({
      kind: "agentTurn",
      message: "do it",
      lightContext: true,
      model: "openai/gpt-5",
      fallbacks: ["anthropic/claude-haiku-3-5"],
      thinking: "low",
      toolsAllow: ["read", "write"],
    });
  });

  it("clears saved model-selection overrides without changing the message", () => {
    const current = agentJob(undefined, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        model: "openai/gpt-5",
        thinking: "high",
        fallbacks: ["openrouter/gpt-4.1-mini"],
      },
    });
    applyJobPatch(current, {
      payload: { kind: "agentTurn", model: null, thinking: null, fallbacks: null },
    });
    expect(current.payload).toEqual({ kind: "agentTurn", message: "do it" });
  });

  it("builds a replacement agent payload with authored settings and default tool authority", () => {
    const current = fixtureJob();
    applyJobPatch(current, {
      sessionTarget: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      payload: {
        kind: "agentTurn",
        message: "hello",
        lightContext: true,
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
        toolsAllow: ["exec", "read"],
        toolsAllowIsDefault: true,
      },
    });
    expect(current.sessionTarget).toBe(
      "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    );
    expect(current.payload).toEqual({
      kind: "agentTurn",
      message: "hello",
      lightContext: true,
      fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
      toolsAllow: ["exec", "read"],
      toolsAllowIsDefault: true,
    });
  });

  it.each([
    {
      patch: { toolsAllow: ["read"], toolsAllowIsDefault: true },
      toolsAllow: ["read"],
      marker: undefined,
    },
    {
      patch: { message: "later", toolsAllow: ["exec", "read"] },
      toolsAllow: ["exec", "read"],
      marker: true,
    },
    { patch: { toolsAllow: null }, toolsAllow: ["*"], marker: undefined },
  ] satisfies {
    patch: Omit<Extract<NonNullable<CronJobPatch["payload"]>, { kind: "agentTurn" }>, "kind">;
    toolsAllow: string[];
    marker: true | undefined;
  }[])("preserves authority semantics for $patch", ({ patch, toolsAllow, marker }) => {
    const current = agentJob(undefined, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["exec", "read"],
        toolsAllowIsDefault: true,
      },
    });
    applyJobPatch(current, { payload: { kind: "agentTurn", ...patch } });
    expect(current.payload.toolsAllow).toEqual(toolsAllow);
    expect(current.payload.toolsAllowIsDefault).toBe(marker);
  });
});

describe("time schedule validation", () => {
  it("rejects overflowing intervals while preserving the inclusive Date boundary", () => {
    expect(() =>
      createJob(
        fixtureState(),
        input({ schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS } }),
      ),
    ).toThrow("cron every schedule has no upcoming run time and would never fire");
    expect(
      createJob(
        fixtureState(),
        input({ schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 } }),
      ).state.nextRunAtMs,
    ).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("rejects invalid one-shot timestamps at the service boundary", () => {
    expect(
      createJob(
        fixtureState(),
        input({ schedule: { kind: "at", at: new Date(MAX_DATE_TIMESTAMP_MS).toISOString() } }),
      ).state.nextRunAtMs,
    ).toBe(MAX_DATE_TIMESTAMP_MS);
    expect(() =>
      createJob(
        fixtureState(),
        input({ schedule: { kind: "at", at: String(MAX_DATE_TIMESTAMP_MS + 1) } }),
      ),
    ).toThrow("Date-valid absolute timestamp");
  });
});

describe("announce delivery channel validation", () => {
  const configuredChannels = ["reef", "discord"];
  const options = { configuredChannels };
  const explicit = () => agentInput({ delivery: { mode: "announce", channel: "discord" } });

  it("revalidates patches that change delivery resolution", () => {
    const current = createJob(fixtureState(), explicit(), options);
    expect(() => applyJobPatch(current, { delivery: { channel: "last" } }, options)).toThrow(
      "cron announce delivery requires an explicit channel",
    );
  });
});

describe("cron tool authority defaults", () => {
  it("preserves explicit empty caps and leaves transport-only jobs capless", () => {
    const noTools = createJob(
      fixtureState(),
      agentInput({
        sessionTarget: "session:project-alpha",
        payload: { kind: "agentTurn", message: "render", toolsAllow: [] },
      }),
    );
    const transportOnly = createJob(fixtureState(), input());
    expect(noTools.payload.toolsAllow).toEqual([]);
    expect(transportOnly.payload.toolsAllow).toBeUndefined();
  });

  it("preserves legacy and explicit authority during declarative convergence", () => {
    const legacy = agentJob({ mode: "none" });
    const explicit = agentJob(
      { mode: "none" },
      {
        payload: {
          kind: "agentTurn",
          message: "explicit",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        },
      },
    );
    const declaration = agentInput({
      payload: { kind: "agentTurn", message: "updated" },
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
});

describe("condition trigger syntax validation", () => {
  const malformedScript = "const x = ;";
  const triggeredInput = (script = "return { fire: true }") => input({ trigger: { script } });

  it("rejects malformed trigger scripts on patch", () => {
    const mutate = (script: string) => {
      const current = createJob(fixtureState(), triggeredInput());
      return applyJobPatch(current, { trigger: { script } });
    };
    expect(() => mutate(malformedScript)).toThrow(
      "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
    );
    expect(() => mutate("   ")).toThrow("cron trigger script must not be empty");
  });

  it("allows removal of a legacy malformed trigger", () => {
    const current = createJob(fixtureState(), triggeredInput());
    current.trigger = { script: malformedScript };
    applyJobPatch(current, { trigger: null }, { cronConfig: { triggers: { enabled: false } } });
    expect(current.trigger).toBeUndefined();
  });
});

describe("script payload validation", () => {
  const scriptInput = (
    script = "return { state: { count: 1 } }",
    sessionTarget: CronJob["sessionTarget"] = "isolated",
  ) =>
    input({
      sessionTarget,
      payload: { kind: "script", script, timeoutSeconds: 4_000, toolBudget: 4_000 },
    });
  const enabled = { cronConfig: { triggers: { enabled: true } } };

  it("rejects malformed scripts on patch", () => {
    const current = createJob(fixtureState(), scriptInput());
    expect(() =>
      applyJobPatch(current, { payload: { kind: "script", script: "const x = ;" } }, enabled),
    ).toThrow("cron script payload has a syntax error");
  });

  it("rejects the current session target", () => {
    expect(() => createJob(fixtureState(), scriptInput("return 1", "current"))).toThrow(
      'sessionTarget="main" or "isolated"',
    );
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
    const base = createJob(fixtureState(), agentInput());
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
});

describe("session targets", () => {
  it("rejects null bytes in custom session targets", () => {
    expect(() =>
      createJob(fixtureState(), agentInput({ sessionTarget: "session:bad\0id" })),
    ).toThrow("invalid cron sessionTarget session id");
  });

  it("rejects failure destinations on created main jobs without webhook delivery", () => {
    expect(() =>
      createJob(
        fixtureState("main"),
        input({
          agentId: "main",
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "123",
            failureDestination: { mode: "announce", channel: "signal", to: "+15550001111" },
          },
        }),
      ),
    ).toThrow('cron channel delivery config is only supported for sessionTarget="isolated"');
  });

  it("rejects patching a main-session job to a non-default agent", () => {
    expect(() =>
      applyJobPatch(fixtureJob(), { agentId: "custom-agent" }, { defaultAgentId: "main" }),
    ).toThrow('cron: sessionTarget "main" is only valid for the default agent');
  });
});

describe("cron schedules", () => {
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
    const current = createJob(fixtureState(), input({ schedule: hourly }));
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
});

function createCronSystemEventJob(now: number, overrides: Partial<CronJob> = {}): CronJob {
  const { state, ...jobOverrides } = overrides;
  return {
    id: "test-job",
    name: "test job",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    payload: { kind: "systemEvent", text: "test" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    createdAtMs: now,
    updatedAtMs: now,
    ...jobOverrides,
    state: state ? { ...state } : {},
  };
}

function testReceipt(jobId: string, startedAtMs: number): CronRunReceiptHandle {
  return {
    receiptId: `test:${jobId}`,
    storeKey: "test",
    jobId,
    configRevision: "test",
    agentId: "main",
    ownerPid: process.pid,
    ownerStartTime: 1,
    startedAtMs,
  };
}

describe("cron maintenance ownership", () => {
  it("clears an orphaned queued marker from before a clock rollback", () => {
    const now = Date.now();
    const futureQueuedAt = now + 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: now + 60_000,
        queuedAtMs: futureQueuedAt,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    expect(job.state.queuedAtMs).toBeUndefined();
  });

  it("preserves a future running marker owned by a live reservation", () => {
    const now = Date.now();
    const futureMarker = now + 3 * 60 * 60_000;
    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: now + 60_000,
        runningAtMs: futureMarker,
      },
    });
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    reserveQueuedCronRun(state, job.id, futureMarker, {
      runReceipt: testReceipt(job.id, futureMarker),
      runReceiptContext: captureOpenClawStateWorkerContext(),
    });

    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    expect(job.state.runningAtMs).toBe(futureMarker);
  });

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1_000;

    const dueJob = createCronSystemEventJob(now, {
      id: "due-job",
      state: {
        nextRunAtMs: pastDue,
      },
    });

    const malformedJob = createCronSystemEventJob(now, {
      id: "bad-job",
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      state: {},
    });

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });

  it("advances overdue already-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
        lastRunAtMs: pastDue + 1000,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: [],
      recomputeExpired: true,
      nowMs: now,
    });

    expect(job.state.runningAtMs).toBeUndefined();
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);
  });
});
