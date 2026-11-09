import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTA_RESUME_COOLDOWN_MARGIN_MS } from "../agents/quota-resume-policy.js";
import type { QuotaSuspension, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  buildQuotaResumeIdempotencyKey,
  isQuotaAutoResumeEnabled,
  startQuotaResumeRuntime,
  type QuotaResumeRuntimeDeps,
} from "./server-quota-resume-runtime.js";

const SUSPENDED_AT = 1_000_000;
const STORE_PATH = "/tmp/openclaw-quota-resume-test/sessions.json";

function suspension(overrides: Partial<QuotaSuspension> = {}): QuotaSuspension {
  return {
    schemaVersion: 1,
    suspendedAt: SUSPENDED_AT,
    reason: "quota_exhausted",
    failedProvider: "openai-codex",
    failedModel: "gpt-6-astra",
    expectedResumeBy: SUSPENDED_AT + 60_000,
    state: "suspended",
    ...overrides,
  };
}

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: SUSPENDED_AT,
    lifecycleRevision: "rev-1",
    quotaSuspension: suspension(),
    ...overrides,
  } as SessionEntry;
}

function createFixture(params: {
  nowMs: number;
  entries: Array<{ sessionKey: string; entry: SessionEntry }>;
  cooldownUntil?: number | null;
  runActive?: boolean;
  launch?: QuotaResumeRuntimeDeps["launch"];
  markResuming?: QuotaResumeRuntimeDeps["markResuming"];
  initialDelayMs?: number;
  readConfig?: () => OpenClawConfig;
}) {
  const time = createGatewaySchedulerClock(params.nowMs);
  const scheduler = createTestGatewayScheduler(time.clock);
  const deps: QuotaResumeRuntimeDeps = {
    listAgentIds: vi.fn(() => ["main"]),
    resolveStorePath: vi.fn(() => STORE_PATH),
    listSessions: vi.fn(() => params.entries),
    isRunActive: vi.fn(() => params.runActive ?? false),
    resolveProviderCooldownUntil: vi.fn(() => params.cooldownUntil ?? null),
    markResuming: params.markResuming ?? vi.fn(async () => true),
    recordLaunchFailure: vi.fn(async () => {}),
    recordLaunchRunId: vi.fn(async () => {}),
    resolveRoute: vi.fn(async () => undefined),
    launch: params.launch ?? vi.fn(async () => ({ runId: "run-1" })),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const runtime = startQuotaResumeRuntime({
    scheduler,
    readConfig: params.readConfig ?? (() => ({}) as OpenClawConfig),
    log,
    deps,
    initialDelayMs: params.initialDelayMs ?? 1_000,
    scanIntervalMs: 60_000,
  });
  return { time, scheduler, deps, log, runtime };
}

describe("quota resume runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_QUOTA_AUTO_RESUME;
  });

  it("launches a due suspended session as a trusted continuation and records the run id", async () => {
    const { deps, runtime, log } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
    });
    await runtime.scanNow();

    expect(deps.markResuming).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        storePath: STORE_PATH,
        sessionKey: "agent:main:dashboard:abc",
        attempt: 1,
        now: SUSPENDED_AT + 120_000,
      }),
    );
    expect(deps.launch).toHaveBeenCalledTimes(1);
    const launch = vi.mocked(deps.launch).mock.calls[0]?.[0];
    expect(launch).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:dashboard:abc",
        sessionId: "session-1",
        lifecycleRevision: "rev-1",
        idempotencyKey: buildQuotaResumeIdempotencyKey({
          sessionId: "session-1",
          suspendedAt: SUSPENDED_AT,
          attempt: 1,
        }),
      }),
    );
    expect(launch?.message.startsWith("[System]")).toBe(true);
    expect(launch?.route).toBeUndefined();
    expect(deps.recordLaunchRunId).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, runId: "run-1" }),
    );
    expect(log.info).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("delivers to the session's external route when one is recorded", async () => {
    const { deps, runtime } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:telegram:123", entry: entry() }],
    });
    vi.mocked(deps.resolveRoute).mockResolvedValue({ channel: "telegram", to: "123" });
    await runtime.scanNow();
    expect(vi.mocked(deps.launch).mock.calls[0]?.[0]?.route).toEqual({
      channel: "telegram",
      to: "123",
    });
    await runtime.stop();
  });

  it("waits for the resume time and wakes exactly then", async () => {
    const { deps, runtime, time, scheduler } = createFixture({
      nowMs: SUSPENDED_AT,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
    });
    await runtime.scanNow();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(SUSPENDED_AT + 1_000);

    // The initial scan fires first and re-arms the wake for the stored resume time.
    await time.advanceTo(SUSPENDED_AT + 1_000);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(SUSPENDED_AT + 60_000);

    await time.advanceTo(SUSPENDED_AT + 60_000);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("defers to a later provider cooldown instead of launching", async () => {
    const cooldownUntil = SUSPENDED_AT + 600_000;
    const { deps, runtime, scheduler, time } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
      cooldownUntil,
      // Keep the periodic scan out of the way so the only wake is the cooldown one.
      initialDelayMs: 24 * 60 * 60 * 1000,
    });
    await runtime.scanNow();
    expect(deps.resolveProviderCooldownUntil).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-codex", model: "gpt-6-astra" }),
    );
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.markResuming).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(cooldownUntil + QUOTA_RESUME_COOLDOWN_MARGIN_MS);

    vi.mocked(deps.resolveProviderCooldownUntil).mockReturnValue(null);
    await time.advanceTo(cooldownUntil + QUOTA_RESUME_COOLDOWN_MARGIN_MS);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("skips stopped, superseded, active, and non-quota sessions without touching the store", async () => {
    const { deps, runtime } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [
        { sessionKey: "aborted", entry: entry({ abortedLastRun: true }) },
        { sessionKey: "superseded", entry: entry({ lastInteractionAt: SUSPENDED_AT + 5 }) },
        {
          sessionKey: "billing",
          entry: entry({ quotaSuspension: suspension({ reason: "manual" }) }),
        },
        {
          sessionKey: "consumed",
          entry: entry({ quotaSuspension: suspension({ state: "active" }) }),
        },
      ],
    });
    await runtime.scanNow();
    expect(deps.markResuming).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("does not launch when the entry changed before it could be marked", async () => {
    const { deps, runtime } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
      markResuming: vi.fn(async () => false),
    });
    await runtime.scanNow();
    expect(deps.launch).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("records a failed launch so the next scan backs off instead of spinning", async () => {
    const { deps, runtime, log } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
      launch: vi.fn(async () => {
        throw new Error("gateway busy");
      }),
    });
    await runtime.scanNow();
    expect(deps.recordLaunchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, error: "gateway busy" }),
    );
    expect(deps.recordLaunchRunId).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("stops scanning once stopped", async () => {
    const { deps, runtime, time } = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: entry() }],
    });
    await runtime.stop();
    await time.advanceBy(120_000);
    expect(deps.listSessions).not.toHaveBeenCalled();
  });

  it("honors the attempt budget from agents.defaults.quotaResume.maxAttempts", async () => {
    const dueEntry = entry({
      quotaSuspension: suspension({
        autoResume: { attempts: 2, nextAttemptAt: SUSPENDED_AT + 60_000 },
      }),
    });
    const capped = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: dueEntry }],
      readConfig: () => ({ agents: { defaults: { quotaResume: { maxAttempts: 2 } } } }),
    });
    await capped.runtime.scanNow();
    expect(capped.deps.markResuming).not.toHaveBeenCalled();
    expect(capped.deps.launch).not.toHaveBeenCalled();
    await capped.runtime.stop();

    // Same entry under the default budget still launches attempt 3.
    const defaults = createFixture({
      nowMs: SUSPENDED_AT + 120_000,
      entries: [{ sessionKey: "agent:main:dashboard:abc", entry: dueEntry }],
    });
    await defaults.runtime.scanNow();
    expect(defaults.deps.launch).toHaveBeenCalledTimes(1);
    expect(defaults.deps.markResuming).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3 }),
    );
    await defaults.runtime.stop();
  });

  it("resolves the enable switch from config with the environment override on top", () => {
    const disabledCfg: OpenClawConfig = {
      agents: { defaults: { quotaResume: { enabled: false } } },
    };
    expect(isQuotaAutoResumeEnabled(undefined, {})).toBe(true);
    expect(isQuotaAutoResumeEnabled({}, {})).toBe(true);
    expect(isQuotaAutoResumeEnabled(disabledCfg, {})).toBe(false);
    expect(isQuotaAutoResumeEnabled(disabledCfg, { OPENCLAW_QUOTA_AUTO_RESUME: "1" })).toBe(true);
    expect(isQuotaAutoResumeEnabled({}, { OPENCLAW_QUOTA_AUTO_RESUME: "0" })).toBe(false);
    expect(isQuotaAutoResumeEnabled({}, { OPENCLAW_QUOTA_AUTO_RESUME: " Off " })).toBe(false);
    expect(isQuotaAutoResumeEnabled(disabledCfg, { OPENCLAW_QUOTA_AUTO_RESUME: "maybe" })).toBe(
      false,
    );
  });
});
