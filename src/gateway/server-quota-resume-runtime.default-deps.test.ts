// Exercises the production dependency set behind the quota-resume service: the
// store compare-and-set transitions and the lifecycle dispatch shape.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTA_RESUME_DEFAULT_RETRY_MS } from "../agents/quota-resume-policy.js";
import type { QuotaSuspension, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { QUOTA_RESUME_SOURCE_TOOL } from "./server-quota-resume-runtime.js";

const storeMocks = vi.hoisted(() => ({
  patchSessionEntryCore: vi.fn(),
  listSessionEntriesReadOnly: vi.fn(() => []),
}));
vi.mock("../config/sessions/session-accessor.js", () => storeMocks);

const lifecycleMocks = vi.hoisted(() => ({
  dispatchAgent: vi.fn(),
  getGatewayLifecycleRuntime: vi.fn(),
}));
vi.mock("./server-lifecycle-runtime-context.js", () => ({
  getGatewayLifecycleRuntime: lifecycleMocks.getGatewayLifecycleRuntime,
}));

const routeMocks = vi.hoisted(() => ({
  resolveGatewayLifecycleNoticeRoute: vi.fn(async () => undefined),
}));
vi.mock("./server-restart-sentinel-notice.js", () => routeMocks);

const authMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {}, usageStats: {} })),
  listProfilesForProvider: vi.fn(() => ["codex-main"]),
  getSoonestCooldownExpiry: vi.fn(() => 4_200),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-quota-resume-default-deps/agent"),
}));
vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: authMocks.ensureAuthProfileStore,
}));
vi.mock("../agents/auth-profiles/profile-list.js", () => ({
  listProfilesForProvider: authMocks.listProfilesForProvider,
}));
vi.mock("../agents/auth-profiles/usage-state.js", () => ({
  getSoonestCooldownExpiry: authMocks.getSoonestCooldownExpiry,
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentDir: authMocks.resolveAgentDir,
}));

const SUSPENDED_AT = 1_000_000;
const NOW = SUSPENDED_AT + 120_000;
const SCOPE = {
  agentId: "main",
  storePath: "/tmp/openclaw-quota-resume-default-deps/sessions.json",
  sessionKey: "agent:main:dashboard:abc",
};

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

type SuspensionPatch = { quotaSuspension?: QuotaSuspension } | null;
let writtenPatch: SuspensionPatch | "unset" = "unset";

/** Runs the production patch callback against a live entry and records the written patch. */
function applyPatch(liveEntry: SessionEntry) {
  writtenPatch = "unset";
  storeMocks.patchSessionEntryCore.mockImplementationOnce(
    async (_scope, update: (current: SessionEntry) => SuspensionPatch) => {
      const patch = update(liveEntry);
      writtenPatch = patch;
      return patch === null ? null : { ...liveEntry, ...patch };
    },
  );
}

function lastPatch(): SuspensionPatch {
  if (writtenPatch === "unset") {
    throw new Error("patchSessionEntryCore was not invoked");
  }
  return writtenPatch;
}

async function loadDeps(resolveGatewayContext?: () => unknown) {
  const { createQuotaResumeDefaultDeps } = await import("./server-quota-resume-runtime.js");
  return await createQuotaResumeDefaultDeps(
    resolveGatewayContext as Parameters<typeof createQuotaResumeDefaultDeps>[0],
  );
}

describe("quota resume default deps", () => {
  beforeEach(() => {
    lifecycleMocks.dispatchAgent.mockReset();
    lifecycleMocks.getGatewayLifecycleRuntime.mockReset();
    lifecycleMocks.getGatewayLifecycleRuntime.mockReturnValue({
      dispatchAgent: lifecycleMocks.dispatchAgent,
    });
    storeMocks.patchSessionEntryCore.mockReset();
    routeMocks.resolveGatewayLifecycleNoticeRoute.mockReset();
    routeMocks.resolveGatewayLifecycleNoticeRoute.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("markResuming", () => {
    it("moves a matching suspended entry to resuming with first-attempt bookkeeping", async () => {
      const deps = await loadDeps();
      const live = entry();
      applyPatch(live);
      const marked = await deps.markResuming({
        ...SCOPE,
        expected: suspension(),
        attempt: 1,
        now: NOW,
      });
      expect(marked).toBe(true);
      expect(storeMocks.patchSessionEntryCore).toHaveBeenCalledWith(SCOPE, expect.any(Function), {
        skipMaintenance: true,
        takeCacheOwnership: true,
      });
      expect(lastPatch()?.quotaSuspension).toEqual(
        expect.objectContaining({
          state: "resuming",
          autoResume: {
            attempts: 1,
            lastAttemptAt: NOW,
            // The first retry waits the base delay, not a doubled one.
            nextAttemptAt: NOW + QUOTA_RESUME_DEFAULT_RETRY_MS,
          },
        }),
      );
    });

    it.each([
      ["the operator stopped the run", entry({ abortedLastRun: true })],
      ["a newer human turn arrived", entry({ lastInteractionAt: SUSPENDED_AT + 1 })],
      [
        "the suspension was replaced",
        entry({ quotaSuspension: suspension({ suspendedAt: SUSPENDED_AT + 50 }) }),
      ],
      [
        "the suspension is a billing block",
        entry({ quotaSuspension: suspension({ reason: "manual" }) }),
      ],
      ["the run already consumed it", entry({ quotaSuspension: suspension({ state: "active" }) })],
      [
        "another scan already advanced the attempt",
        entry({ quotaSuspension: suspension({ autoResume: { attempts: 1 } }) }),
      ],
      ["the suspension is gone", entry({ quotaSuspension: undefined })],
    ])("refuses the live row when %s", async (_label, live) => {
      const deps = await loadDeps();
      applyPatch(live);
      const marked = await deps.markResuming({
        ...SCOPE,
        expected: suspension(),
        attempt: 1,
        now: NOW,
      });
      expect(marked).toBe(false);
    });
  });

  describe("recordLaunchFailure / recordLaunchRunId", () => {
    it("rolls a lost launch back to suspended with backoff and keeps the attempt count", async () => {
      const deps = await loadDeps();
      const live = entry({
        quotaSuspension: suspension({
          state: "resuming",
          autoResume: { attempts: 2, lastAttemptAt: NOW - 1 },
        }),
      });
      applyPatch(live);
      await deps.recordLaunchFailure({ ...SCOPE, attempt: 2, now: NOW, error: "gateway busy" });
      expect(lastPatch()?.quotaSuspension).toEqual(
        expect.objectContaining({
          state: "suspended",
          autoResume: expect.objectContaining({
            attempts: 2,
            lastAttemptAt: NOW,
            nextAttemptAt: NOW + QUOTA_RESUME_DEFAULT_RETRY_MS * 2,
          }),
        }),
      );
    });

    it("leaves the row alone when the attempt no longer matches", async () => {
      const deps = await loadDeps();
      const live = entry({
        quotaSuspension: suspension({ state: "resuming", autoResume: { attempts: 3 } }),
      });
      applyPatch(live);
      await deps.recordLaunchFailure({ ...SCOPE, attempt: 2, now: NOW, error: "late" });
      expect(lastPatch()).toBeNull();
    });

    it("records the accepted run id on the matching attempt only", async () => {
      const deps = await loadDeps();
      const live = entry({
        quotaSuspension: suspension({ state: "resuming", autoResume: { attempts: 1 } }),
      });
      applyPatch(live);
      await deps.recordLaunchRunId({ ...SCOPE, attempt: 1, runId: "run-9" });
      expect(lastPatch()?.quotaSuspension?.autoResume).toEqual({ attempts: 1, lastRunId: "run-9" });

      applyPatch(live);
      await deps.recordLaunchRunId({ ...SCOPE, attempt: 2, runId: "run-10" });
      expect(lastPatch()).toBeNull();
    });
  });

  describe("launch", () => {
    it("dispatches one trusted continuation bound to the session and captures the run id", async () => {
      const deps = await loadDeps();
      lifecycleMocks.dispatchAgent.mockImplementation(
        async (_params, _timeoutMs, options?: { onAccepted?: (payload: unknown) => void }) => {
          options?.onAccepted?.({ runId: "run-42" });
          return { status: "accepted" };
        },
      );
      const result = await deps.launch({
        agentId: "main",
        sessionKey: SCOPE.sessionKey,
        sessionId: "session-1",
        lifecycleRevision: null,
        message: "[System] continue",
        idempotencyKey: "quota-resume:session-1:1",
        route: { channel: "telegram", to: "123", threadId: "7" },
      });
      expect(result).toEqual({ runId: "run-42" });
      expect(lifecycleMocks.dispatchAgent).toHaveBeenCalledTimes(1);
      const [params, timeoutMs, options] = lifecycleMocks.dispatchAgent.mock.calls[0] ?? [];
      expect(params).toEqual({
        sessionKey: SCOPE.sessionKey,
        agentId: "main",
        expectedExistingSessionId: "session-1",
        expectedExistingSessionLifecycleRevision: null,
        message: "[System] continue",
        deliver: true,
        bestEffortDeliver: true,
        channel: "telegram",
        to: "123",
        threadId: "7",
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: SCOPE.sessionKey,
          sourceTool: QUOTA_RESUME_SOURCE_TOOL,
        },
        idempotencyKey: "quota-resume:session-1:1",
      });
      expect(timeoutMs).toBe(30_000);
      expect(options).toEqual(
        expect.objectContaining({ expectFinal: false, forceSyntheticClient: true }),
      );
    });

    it("keeps internal sessions internal and fails when no Gateway runtime owns dispatch", async () => {
      const deps = await loadDeps();
      lifecycleMocks.dispatchAgent.mockResolvedValue({});
      const result = await deps.launch({
        agentId: "main",
        sessionKey: SCOPE.sessionKey,
        sessionId: "session-1",
        lifecycleRevision: "rev-1",
        message: "[System] continue",
        idempotencyKey: "quota-resume:session-1:1",
      });
      expect(result).toEqual({});
      expect(lifecycleMocks.dispatchAgent.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          deliver: false,
          expectedExistingSessionLifecycleRevision: "rev-1",
        }),
      );

      lifecycleMocks.getGatewayLifecycleRuntime.mockReturnValue(undefined);
      await expect(
        deps.launch({
          agentId: "main",
          sessionKey: SCOPE.sessionKey,
          sessionId: "session-1",
          lifecycleRevision: null,
          message: "[System] continue",
          idempotencyKey: "quota-resume:session-1:2",
        }),
      ).rejects.toThrow(/lifecycle runtime unavailable/);
    });

    it("prefers the bound Gateway context over the process-global runtime", async () => {
      const boundDispatch = vi.fn(async () => ({}));
      const deps = await loadDeps(() => ({ lifecycleRuntime: { dispatchAgent: boundDispatch } }));
      await deps.launch({
        agentId: "main",
        sessionKey: SCOPE.sessionKey,
        sessionId: "session-1",
        lifecycleRevision: null,
        message: "[System] continue",
        idempotencyKey: "quota-resume:session-1:3",
      });
      expect(boundDispatch).toHaveBeenCalledTimes(1);
      expect(lifecycleMocks.dispatchAgent).not.toHaveBeenCalled();
    });
  });

  describe("resolveProviderCooldownUntil", () => {
    it("reads the failed provider's profiles from the agent auth store", async () => {
      const deps = await loadDeps();
      const cfg = {} as OpenClawConfig;
      expect(
        deps.resolveProviderCooldownUntil({
          cfg,
          agentId: "main",
          provider: "openai-codex",
          model: "gpt-6-astra",
          now: NOW,
        }),
      ).toBe(4_200);
      expect(authMocks.resolveAgentDir).toHaveBeenCalledWith(cfg, "main");
      expect(authMocks.getSoonestCooldownExpiry).toHaveBeenCalledWith(
        expect.anything(),
        ["codex-main"],
        { now: NOW, forModel: "gpt-6-astra" },
      );

      authMocks.listProfilesForProvider.mockReturnValueOnce([]);
      expect(
        deps.resolveProviderCooldownUntil({
          cfg,
          agentId: "main",
          provider: "nobody",
          model: "x",
          now: NOW,
        }),
      ).toBeNull();
    });
  });
});
