import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { normalizeCronJobPatch } from "./normalize.js";
import { DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS } from "./script-payload.js";
import {
  computeJobNextRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  nextWakeAtMs,
} from "./service/jobs-scheduling.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const WEBHOOK = "https://example.invalid/cron";
const CREDENTIAL_WEBHOOK_URL = (() => {
  const url = new URL(WEBHOOK);
  url.username = "user";
  url.password = "password";
  return url.href;
})();

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

function job(overrides: Partial<CronJob> = {}): CronJob {
  return { ...input(), id: "job", createdAtMs: NOW, updatedAtMs: NOW, state: {}, ...overrides };
}

function agentJob(delivery?: CronJob["delivery"], overrides: Partial<CronJob> = {}): CronJob {
  return job({ ...agentInput(), delivery, ...overrides });
}

function state(defaultAgentId?: string): CronServiceState {
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

  it.each([
    { delivery: { mode: "announce", channel: "telegram", to: "123" }, expected: undefined },
    { delivery: { mode: "webhook", to: WEBHOOK }, expected: { mode: "webhook", to: WEBHOOK } },
  ] satisfies { delivery: CronJob["delivery"]; expected: CronJob["delivery"] }[])(
    "retargets $delivery.mode delivery to main",
    ({ delivery, expected }) => {
      const current = agentJob(delivery);
      applyJobPatch(current, {
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "ping" },
      });
      expect(current.sessionTarget).toBe("main");
      expect(current.payload.kind).toBe("systemEvent");
      expect(current.delivery).toEqual(expected);
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

  it.each([
    { patch: { mode: "none" }, mode: "none" },
    { patch: { completionDestination: null }, mode: "announce" },
  ] satisfies { patch: NonNullable<CronJobPatch["delivery"]>; mode: string }[])(
    "clears a completion webhook with $patch",
    ({ patch, mode }) => {
      const current = agentJob({
        mode: "announce",
        completionDestination: { mode: "webhook", to: WEBHOOK },
      });
      applyJobPatch(current, { delivery: patch });
      expect(current.delivery?.mode).toBe(mode);
      expect(current.delivery?.completionDestination).toBeUndefined();
    },
  );

  it("rejects completion webhooks on disabled delivery", () => {
    expect(() =>
      applyJobPatch(agentJob({ mode: "announce" }), {
        delivery: { mode: "none", completionDestination: { mode: "webhook", to: WEBHOOK } },
      }),
    ).toThrow(
      'cron completion destination webhook is only supported with delivery.mode="announce"',
    );
  });

  it("clears webhook targets when switching to announce", () => {
    const current = agentJob({ mode: "webhook", to: WEBHOOK });
    applyJobPatch(current, { delivery: { mode: "announce" } });
    expect(current.delivery).toEqual({ mode: "announce" });
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

  it.each([
    { enabled: true },
    { delivery: { mode: "webhook", to: "" } },
    { delivery: { mode: "webhook", to: "ftp://example.invalid" } },
    { delivery: { mode: "webhook", to: "not-a-url" } },
    { delivery: { mode: "webhook", to: CREDENTIAL_WEBHOOK_URL } },
  ] satisfies CronJobPatch[])("rejects invalid webhook delivery: %j", (patch) => {
    expect(() => applyJobPatch(job({ delivery: { mode: "webhook" } }), patch)).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
  });

  it("rejects failure destinations on existing non-webhook main jobs", () => {
    const current = job({
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
    const current = job();
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

  it("omits cleared overrides when replacing a non-agent payload", () => {
    const current = job();
    applyJobPatch(current, {
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "do it",
        model: null,
        thinking: null,
        fallbacks: null,
      },
    });
    expect(current.payload).toEqual({ kind: "agentTurn", message: "do it", toolsAllow: ["*"] });
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
      createJob(state(), input({ schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS } })),
    ).toThrow("cron every schedule has no upcoming run time and would never fire");
    expect(
      createJob(
        state(),
        input({ schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 } }),
      ).state.nextRunAtMs,
    ).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("rejects invalid one-shot timestamps at the service boundary", () => {
    expect(
      createJob(
        state(),
        input({ schedule: { kind: "at", at: new Date(MAX_DATE_TIMESTAMP_MS).toISOString() } }),
      ).state.nextRunAtMs,
    ).toBe(MAX_DATE_TIMESTAMP_MS);
    expect(() =>
      createJob(
        state(),
        input({ schedule: { kind: "at", at: String(MAX_DATE_TIMESTAMP_MS + 1) } }),
      ),
    ).toThrow("Date-valid absolute timestamp");
  });
});

describe("announce delivery channel validation", () => {
  const configuredChannels = ["reef", "discord"];
  const options = { configuredChannels };
  const ambiguous = () => agentInput({ delivery: { mode: "announce", channel: "last" } });
  const explicit = () => agentInput({ delivery: { mode: "announce", channel: "discord" } });

  it("rejects creation without a deterministic channel", () => {
    expect(() => createJob(state(), ambiguous(), options)).toThrow(
      "cron announce delivery requires an explicit channel when multiple channels are configured (discord, reef): set --channel <id> or use --best-effort-deliver",
    );
  });

  it("accepts explicit best-effort delivery", () => {
    const created = createJob(
      state(),
      agentInput({ delivery: { mode: "announce", channel: "last", bestEffort: true } }),
      options,
    );
    expect(created.delivery).toEqual({ mode: "announce", channel: "last", bestEffort: true });
  });

  it.each([
    { sessionKey: "agent:main:discord:channel:ops" },
    { delivery: { mode: "announce", channel: "last", to: "telegram:123" } },
  ] satisfies Partial<CronJobCreate>[])("accepts a deterministic preserved route: %j", (route) => {
    expect(createJob(state(), { ...ambiguous(), ...route }, options)).toMatchObject(route);
  });

  it("keeps metadata-only patches working for stored ambiguous jobs", () => {
    const current = createJob(state(), explicit(), options);
    current.delivery = { mode: "announce", channel: "last" };
    applyJobPatch(current, { enabled: false }, options);
    expect(current.enabled).toBe(false);
  });

  it("revalidates patches that change delivery resolution", () => {
    const current = createJob(state(), explicit(), options);
    expect(() => applyJobPatch(current, { delivery: { channel: "last" } }, options)).toThrow(
      "cron announce delivery requires an explicit channel",
    );
  });

  it("rejects ambiguous declarative convergence", () => {
    const current = createJob(state(), explicit(), options);
    expect(() =>
      applyDeclarativeJobSpec(current, ambiguous(), { ...convergence, ...options }),
    ).toThrow("cron announce delivery requires an explicit channel");
  });
});

describe("cron tool authority defaults", () => {
  it("preserves explicit empty caps and leaves transport-only jobs capless", () => {
    const noTools = createJob(
      state(),
      agentInput({
        sessionTarget: "session:project-alpha",
        payload: { kind: "agentTurn", message: "render", toolsAllow: [] },
      }),
    );
    const transportOnly = createJob(state(), input());
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

  it("repairs a missing anchor when converging an unchanged every schedule", () => {
    const current = job({ createdAtMs: NOW - 30_000 });
    applyDeclarativeJobSpec(current, input(), { ...convergence, enabledExplicit: false });
    expect(current.schedule).toEqual({ kind: "every", everyMs: 60_000, anchorMs: NOW - 30_000 });
  });

  it("adopts explicit authority when a declaration becomes tool-bearing", () => {
    const current = job();
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

  it.each(["create", "patch", "declarative"] as const)(
    "rejects malformed trigger scripts on %s",
    (mutation) => {
      const mutate = (script: string) => {
        if (mutation === "create") {
          return createJob(state(), triggeredInput(script));
        }
        const current = createJob(state(), triggeredInput());
        if (mutation === "patch") {
          return applyJobPatch(current, { trigger: { script } });
        }
        applyDeclarativeJobSpec(current, triggeredInput(script), convergence);
      };
      expect(() => mutate(malformedScript)).toThrow(
        "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
      );
      expect(() => mutate("   ")).toThrow("cron trigger script must not be empty");
    },
  );

  it("accepts top-level await and return in trigger scripts", () => {
    const script = "await tools.wait(1); return { fire: true }";
    expect(createJob(state(), triggeredInput(script)).trigger).toEqual({ script });
  });

  it.each([
    { name: "renamed condition", enabled: false },
    { trigger: null },
  ] satisfies CronJobPatch[])(
    "allows metadata edits and removal of legacy malformed triggers: %j",
    (patch) => {
      const current = createJob(state(), triggeredInput());
      current.trigger = { script: malformedScript };
      applyJobPatch(current, patch, { cronConfig: { triggers: { enabled: false } } });
      if (!("trigger" in patch)) {
        expect(current).toMatchObject(patch);
      }
      expect(current.trigger).toEqual("trigger" in patch ? undefined : { script: malformedScript });
    },
  );

  it("clears a legacy malformed trigger when a disabled declaration omits it", () => {
    const current = createJob(state(), triggeredInput());
    current.trigger = { script: malformedScript };
    applyDeclarativeJobSpec(current, input(), {
      ...convergence,
      enabledExplicit: false,
      cronConfig: { triggers: { enabled: false } },
    });
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

  it("rejects malformed scripts on creation with a user-relative location", () => {
    expect(() => createJob(state(), scriptInput("const x = ;"))).toThrow(
      "cron script payload has a syntax error: Unexpected token (line 1, column 10)",
    );
  });

  it("rejects malformed scripts on patch", () => {
    const current = createJob(state(), scriptInput());
    expect(() =>
      applyJobPatch(current, { payload: { kind: "script", script: "const x = ;" } }, enabled),
    ).toThrow("cron script payload has a syntax error");
  });

  it("still allows disabling a job stored with a malformed script", () => {
    const current = createJob(state(), scriptInput());
    current.payload = { ...current.payload, kind: "script", script: "const x = ;" };
    applyJobPatch(current, { enabled: false }, enabled);
    expect(current.enabled).toBe(false);
  });

  it("allows a main-session script for a named agent", () => {
    const created = createJob(state("main"), {
      ...scriptInput("await tools.wait(1); return 1", "main"),
      agentId: "reporter",
    });
    expect(created).toMatchObject({ sessionTarget: "main", agentId: "reporter" });
  });

  it("rejects the current session target", () => {
    expect(() => createJob(state(), scriptInput("return 1", "current"))).toThrow(
      'sessionTarget="main" or "isolated"',
    );
  });

  it("rejects condition triggers because both script kinds own trigger.state", () => {
    const serviceState = state();
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
    const base = createJob(state(), agentInput());
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
    expect(() => createJob(state(), agentInput({ sessionTarget: "session:bad\0id" }))).toThrow(
      "invalid cron sessionTarget session id",
    );
  });

  it("rejects failure destinations on created main jobs without webhook delivery", () => {
    expect(() =>
      createJob(
        state("main"),
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
      applyJobPatch(job(), { agentId: "custom-agent" }, { defaultAgentId: "main" }),
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
    const serviceState = state();
    serviceState.store = {
      version: 1,
      jobs: [
        job({
          enabled: undefined as unknown as boolean,
          schedule: { kind: "at", at: new Date(NOW + 60_000).toISOString() },
          state: { nextRunAtMs: NOW + 60_000 },
        }),
      ],
    };
    expect(nextWakeAtMs(serviceState)).toBe(NOW + 60_000);
  });

  it("derives fresh top-of-hour staggering when replacing an expression", () => {
    const current = job({ schedule: hourly });
    applyJobPatch(current, { schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" } });
    expect(current.schedule).toEqual({ ...hourly, expr: "0 */2 * * *", staggerMs: 300_000 });
  });

  it("drops old staggering when the replacement expression has no default", () => {
    const current = job({ schedule: hourly });
    applyJobPatch(current, { schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } });
    expect(current.schedule).toEqual({ kind: "cron", expr: "30 9 * * *", tz: "UTC" });
  });

  it("preserves explicit staggering when declarative convergence keeps the expression", () => {
    const current = createJob(state(), input({ schedule: hourly }));
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

  it("includes exact and subsecond previous-run boundaries", () => {
    const current = job({
      schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
    });
    expect(computeJobPreviousRunAtOrBeforeMs(current, NOW)).toBe(NOW);
    expect(computeJobPreviousRunAtOrBeforeMs(current, NOW + 500)).toBe(NOW);
    expect(computeJobPreviousRunAtOrBeforeMs(current, NOW + 999)).toBe(NOW);
  });

  it("keeps a staggered slot in the current hour and includes its exact previous-run boundary", () => {
    const current = job({
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
