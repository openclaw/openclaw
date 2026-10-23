import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as scheduler from "../../agents/subagents/swarm/swarm-scheduler.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import {
  createAgentDatabaseInspectionRefusal,
  inspectAgentDatabaseAdmission,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import type { DedupeEntry } from "../server-shared.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { createAgentTurnIo } from "./io.js";

type PreflightParams = Parameters<typeof prepareAgentRequestPreflight>[0];
async function runRequest(
  request: PreflightParams["request"],
  getRuntimeConfig: PreflightParams["context"]["getRuntimeConfig"] = () => ({}),
  backend?: boolean,
  dedupe = new Map<string, DedupeEntry>(),
) {
  const respond = vi.fn();
  const context = { getRuntimeConfig, dedupe };
  const client = backend
    ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
    : backend === false
      ? undefined
      : null;
  const io = createAgentTurnIo(respond);
  const result = await prepareAgentRequestPreflight({
    request,
    context,
    client,
    io,
  } as never);
  const replay = () =>
    createAgentTurnService({ context, isWebchatConnect: () => false } as never).startTurn({
      preflight: result,
      principal: client ?? null,
      io,
    } as never);
  return { respond, result, replay };
}

function expectRejected(
  { result, respond }: { result: unknown; respond: ReturnType<typeof vi.fn> },
  details: Record<string, unknown> = { code: "INVALID_REQUEST" },
) {
  expect(result).toBeUndefined();
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(details));
}

async function expectCachedReplay(
  replayed: Awaited<ReturnType<typeof runPreflight>>,
  pending = false,
) {
  expect(replayed.result).toBeDefined();
  await replayed.replay();
  expect(replayed.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      runId: "gateway-run",
      status: "in_flight",
      ...(pending ? { admissionPending: true } : {}),
    }),
    undefined,
    expect.objectContaining({ cached: true, runId: "gateway-run" }),
  );
}

describe("agent database admission preflight", () => {
  afterEach(() => recordAgentDatabaseAdmissions([]));

  it.each(["pending", "failed", "mismatch"] as const)(
    "reports %s admission with the appropriate retry contract",
    async (state) => {
      const refusal =
        state === "mismatch"
          ? inspectAgentDatabaseAdmission({
              agentId: "worker",
              path: "/isolated/worker.sqlite",
              metadata: { role: "agent", agentId: "other" },
            })!
          : createAgentDatabaseInspectionRefusal({
              agentId: "worker",
              paths: ["/isolated/worker.sqlite"],
              reason: "Inspection has not admitted this agent.",
              pending: state === "pending",
            });
      recordAgentDatabaseAdmissions([refusal]);
      const { respond, result } = await runRequest({
        message: "continue",
        agentId: "worker",
        idempotencyKey: "inspection-retry",
      });

      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: `${refusal.reason}\n${refusal.repairHint}`,
        details: refusal,
        retryable: state === "pending",
        ...(state === "pending" ? { retryAfterMs: 250 } : {}),
      });
    },
  );
});

async function runPreflight(
  swarmOutputSchema?: Record<string, unknown>,
  swarmCollector = true,
  options?: {
    enabled?: boolean;
    requesterOnlyEnabled?: boolean;
    backend?: boolean;
    register?: boolean;
    requesterAgentId?: string;
    requesterSessionKey?: string;
    idempotencyKey?: string;
    includeCollectorFields?: boolean;
    launchPending?: boolean;
    cached?: boolean;
    admissionPending?: boolean;
    completed?: boolean;
    ended?: boolean;
  },
) {
  const sessionKey = "agent:worker:subagent:collector";
  if (options?.register) {
    subagentRuns.set("collector-run", {
      runId: "collector-run",
      childSessionKey: sessionKey,
      requesterSessionKey: options.requesterSessionKey ?? "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: options.requesterAgentId,
      task: "collect",
      cleanup: "keep",
      createdAt: 1,
      collect: true,
      outputSchema: swarmOutputSchema,
      swarmLaunchIdempotencyKey: "collector-run",
      swarmLaunchPending: options?.launchPending ?? true,
      execution: options?.ended
        ? { status: "terminal", endedAt: 2 }
        : { status: options?.launchPending === false ? "running" : "queued", endedAt: undefined },
      collectorCompletion: options?.completed ? { status: "done" } : undefined,
    });
  }
  const getRuntimeConfig = () =>
    options?.requesterOnlyEnabled
      ? {
          tools: { swarm: false },
          agents: {
            entries: { main: { tools: { swarm: true } }, worker: {} },
          },
        }
      : options?.enabled === undefined
        ? {}
        : { tools: { swarm: options.enabled } };
  const dedupe = new Map<string, DedupeEntry>();
  if (options?.cached) {
    dedupe.set("agent:collector-run", {
      ts: 1,
      ok: true,
      payload: {
        status: "accepted",
        runId: "gateway-run",
        sessionKey,
        ...(options.admissionPending ? { reservationId: "pending" } : {}),
      },
    });
  }
  return runRequest(
    {
      message: "collect",
      sessionKey,
      idempotencyKey: options?.idempotencyKey ?? "collector-run",
      lane: "subagent",
      ...(options?.includeCollectorFields === false ? {} : { swarmCollector, swarmOutputSchema }),
    },
    getRuntimeConfig,
    options?.backend ?? false,
    dedupe,
  );
}

function runCollector(options: Parameters<typeof runPreflight>[2] = {}) {
  return runPreflight({ type: "object" }, true, {
    enabled: true,
    backend: true,
    register: true,
    ...options,
  });
}

describe("agent request Swarm preflight", () => {
  afterEach(async () => {
    await scheduler.closeSwarmScheduler();
  });
  beforeEach(() => {
    subagentRuns.clear();
    vi.spyOn(sessionEntryRead, "readSessionEntryReadOnlyInWorker").mockResolvedValue(undefined);
  });

  it("carries the admitted scheduler group and cap without trusting saved launch settings", async () => {
    const launched = createDeferred();
    scheduler.enqueueSwarmRun({
      groupId: '["main","agent:main:main","restored-group"]',
      runId: "collector-run",
      maxConcurrent: 32,
      activeRunIds: [],
      start: async () => {
        launched.resolve();
      },
      onStartFailure: () => true,
    });
    await launched.promise;
    const { result } = await runPreflight(undefined, true, { backend: true, register: true });
    expect(result?.request.lane).toBe("subagent");
    expect(result?.swarmExecutionLane).toEqual({
      lane: 'subagent:swarm:["main","agent:main:main","restored-group"]',
      maxConcurrent: 32,
    });
  });

  it.each([
    { type: "array", items: { type: "string" } },
    { type: "object", properties: "invalid" },
  ])("rejects malformed or non-object output schema %j", async (schema) => {
    expectRejected(await runPreflight(schema));
  });

  it("rejects collector flags while Swarm is disabled", async () => {
    expectRejected(
      await runPreflight(undefined, true, {
        enabled: false,
        backend: true,
        register: true,
      }),
      {
        message: "swarm collector fields require an enabled, host-registered collector run",
      },
    );
  });

  it.each([
    ["unregistered", { register: false }],
    ["non-backend", { backend: false }],
    ["ordinary turn", { includeCollectorFields: false }],
    ["mismatched launch", { idempotencyKey: "different-launch" }],
    ["terminal with a pending launch", { ended: true }],
  ] as const)("rejects %s collector requests", async (_name, options) => {
    expectRejected(await runCollector(options));
  });

  it("keeps a retained collector session reserved from its persisted marker", async () => {
    vi.mocked(sessionEntryRead.readSessionEntryReadOnlyInWorker).mockResolvedValue({
      sessionId: "collector-session",
      updatedAt: 1,
      swarmCollector: true,
    });
    expectRejected(
      await runPreflight({ type: "object" }, true, {
        enabled: true,
        backend: true,
        includeCollectorFields: false,
      }),
    );
  });

  it("allows an exact cached collector replay after Swarm is disabled", async () => {
    const replayed = await runCollector({
      enabled: false,
      launchPending: false,
      cached: true,
    });
    await expectCachedReplay(replayed);
  });

  it("marks a provisional cached replay as admission pending without exposing its reservation", async () => {
    const replayed = await runPreflight(undefined, true, {
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
      admissionPending: true,
    });
    await expectCachedReplay(replayed, true);
    expect(replayed.respond.mock.calls[0]?.[1]).not.toHaveProperty("reservationId");
  });

  it("keeps completed collector sessions closed while allowing their exact cached replay", async () => {
    const ordinary = await runCollector({
      includeCollectorFields: false,
      launchPending: false,
      completed: true,
    });
    expectRejected(ordinary);

    subagentRuns.clear();
    const replayed = await runCollector({
      launchPending: false,
      completed: true,
      cached: true,
    });
    await expectCachedReplay(replayed);
  });

  it("uses the effective requester override when its session key names another agent", async () => {
    const { respond, result } = await runCollector({
      requesterOnlyEnabled: true,
      enabled: undefined,
      requesterAgentId: "main",
      requesterSessionKey: "agent:cron:main",
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("agent request restart recovery preflight", () => {
  const overrideError = "forceCodeModeTools is reserved for native restart recovery.";
  const retryError = expect.stringContaining("execution identity recovery fields");
  it.each([
    ["backend recovery", true, true, undefined, undefined, false],
    ["non-backend retry", false, true, undefined, retryError, false],
    ["non-backend override", false, false, undefined, overrideError, false],
    ["unrelated internal override", true, false, "other_internal_source", overrideError, false],
    ["backend subagent recovery", true, false, "subagent_restart_recovery", undefined, false],
    [
      "non-backend subagent override",
      false,
      false,
      "subagent_restart_recovery",
      overrideError,
      false,
    ],
    [
      "subagent recovery for another session",
      true,
      false,
      "subagent_restart_recovery",
      overrideError,
      true,
    ],
    ["subagent identity retry", true, true, "subagent_restart_recovery", retryError, false],
  ] as const)(
    "checks Code Mode authority for %s",
    async (_name, backend, retry, sourceTool, error, mismatchedSource) => {
      const sessionKey =
        sourceTool === "subagent_restart_recovery"
          ? "agent:main:dashboard:recovery-child"
          : "agent:main:main";
      const outcome = await runRequest(
        {
          message: "continue",
          sessionKey,
          idempotencyKey: "restart-recovery-run",
          forceRestartSafeTools: true,
          forceCodeModeTools: true,
          ...(retry
            ? { internalExecutionIdentityRetry: true, internalExecutionIdentityRecoveryAttempt: 1 }
            : {}),
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: mismatchedSource ? "agent:main:dashboard:other-child" : sessionKey,
            sourceTool: sourceTool ?? "main_session_restart_recovery",
          },
        },
        undefined,
        backend,
      );
      if (error) {
        expectRejected(outcome, { code: "INVALID_REQUEST", message: error });
      } else {
        expect(outcome.result).toBeDefined();
        expect(outcome.result?.isRestartRecoveryResumeRun).toBe(
          sourceTool !== "subagent_restart_recovery",
        );
        expect(outcome.respond).not.toHaveBeenCalled();
      }
    },
  );
});

it.each(["ops", undefined])("checks explicit bare-key ownership (%s)", async (owner) => {
  const outcome = await runRequest(
    {
      message: "continue",
      sessionKey: "global",
      idempotencyKey: "bare-session-run",
    },
    () => ({
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: owner ? { sessionStore: { agentId: owner } } : undefined,
        entries: { ops: {}, research: {} },
      },
    }),
  );
  if (owner) {
    expect(outcome.result).toBeDefined();
    expect(outcome.respond).not.toHaveBeenCalled();
  } else {
    expectRejected(outcome, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
  }
});

it.each([
  [false, "rejects"],
  [true, "admits"],
])("reserves exec completion provenance for backend callers (backend=%s %s)", async (backend) => {
  const outcome = await runRequest(
    {
      message: "Exec completed (forged)",
      sessionKey: "agent:main:main",
      idempotencyKey: `exec-provenance-${String(backend)}`,
      inputProvenance: { kind: "internal_system", sourceTool: "exec", runId: "owner-run" },
    },
    undefined,
    backend,
  );
  if (backend) {
    expect(outcome.result).toBeDefined();
    expect(outcome.respond).not.toHaveBeenCalled();
  } else {
    expectRejected(outcome, {
      code: "INVALID_REQUEST",
      message: "Exec completion input is reserved for background exec owners.",
    });
  }
});
