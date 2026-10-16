import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as acpSessionMeta from "../../acp/runtime/session-meta-readonly.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  enqueueSwarmRun,
  closeSwarmScheduler,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { testing as swarmScheduler } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import {
  createAgentDatabaseInspectionRefusal,
  inspectAgentDatabaseAdmission,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import * as sessionStoreLookup from "../session-utils-store-lookup.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { createAgentTurnIo } from "./io.js";

type PreflightParams = Parameters<typeof prepareAgentRequestPreflight>[0];
async function runRequest(
  request: PreflightParams["request"],
  getRuntimeConfig: PreflightParams["context"]["getRuntimeConfig"] = () => ({}),
  backend?: boolean,
) {
  const respond = vi.fn();
  const result = await prepareAgentRequestPreflight({
    request,
    context: { getRuntimeConfig, dedupe: new Map() },
    client: backend
      ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
      : backend === false
        ? undefined
        : null,
    io: createAgentTurnIo(respond),
  } as never);
  return { respond, result };
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
      execution: {
        status: options?.ended
          ? "terminal"
          : options?.launchPending === false
            ? "running"
            : "queued",
        endedAt: options?.ended ? 2 : undefined,
      },
      collectorCompletion: options?.completed ? { status: "done" } : undefined,
    });
  }
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () =>
      options?.requesterOnlyEnabled
        ? {
            tools: { swarm: false },
            agents: {
              entries: { main: { tools: { swarm: true } }, worker: {} },
            },
          }
        : options?.enabled === undefined
          ? {}
          : { tools: { swarm: options.enabled } },
    dedupe: options?.cached
      ? new Map([
          [
            "agent:collector-run",
            {
              ts: 1,
              ok: true,
              payload: {
                status: "accepted",
                runId: "gateway-run",
                sessionKey,
                ...(options.admissionPending ? { reservationId: "pending" } : {}),
              },
            },
          ],
        ])
      : new Map(),
  };
  const client = options?.backend
    ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
    : undefined;
  const io = createAgentTurnIo(respond);
  const result = await prepareAgentRequestPreflight({
    request: {
      message: "collect",
      sessionKey,
      idempotencyKey: options?.idempotencyKey ?? "collector-run",
      lane: "subagent",
      ...(options?.includeCollectorFields === false ? {} : { swarmCollector, swarmOutputSchema }),
    },
    io,
    context,
    client,
  } as never);
  const replay = async () => {
    if (!result) {
      return;
    }
    await createAgentTurnService({ context, isWebchatConnect: () => false } as never).startTurn({
      preflight: result,
      principal: client ?? null,
      io,
    } as never);
  };
  return { respond, result, replay };
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
    await closeSwarmScheduler();
    swarmScheduler.reset();
  });
  beforeEach(() => {
    subagentRuns.clear();
    vi.spyOn(sessionEntryRead, "readSessionEntryReadOnlyInWorker").mockResolvedValue(undefined);
    vi.spyOn(acpSessionMeta, "readAcpSessionMetaForEntries").mockResolvedValue([null]);
  });

  it("carries the admitted scheduler group and cap without trusting saved launch settings", async () => {
    const launched = createDeferred();
    enqueueSwarmRun({
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
    {
      entry: { sessionId: "source", updatedAt: 1, spawnDepth: 1 },
      sourceAcp: undefined,
      expectedRole: "subagent",
    },
    {
      entry: { sessionId: "source", updatedAt: 1, parentSessionKey: "agent:main:root" },
      sourceAcp: undefined,
      expectedRole: undefined,
    },
    {
      entry: {
        sessionId: "source",
        updatedAt: 1,
        parentSessionKey: "agent:main:root",
        spawnDepth: 0,
      },
      sourceAcp: {
        backend: "acpx",
        agent: "worker",
        runtimeSessionName: "worker",
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 1,
      },
      expectedRole: "subagent",
    },
  ])(
    "derives coordination source role from canonical spawn lineage ($expectedRole)",
    async ({ entry, sourceAcp, expectedRole }) => {
      const sourceKey = "agent:main:visible-worker";
      vi.spyOn(sessionStoreLookup, "withGatewaySessionStoreTarget").mockImplementation(
        async (_params, consume) =>
          consume(
            {
              agentId: "main",
              canonicalKey: sourceKey,
              storePath: "/source-store",
              storeKeys: [sourceKey],
              store: { [sourceKey]: entry },
            },
            new Map(),
            () => {},
            [],
          ),
      );
      vi.mocked(acpSessionMeta.readAcpSessionMetaForEntries).mockResolvedValue([sourceAcp ?? null]);
      const { result } = await runRequest({
        message: "Worker progress",
        sessionKey: "agent:main:root",
        idempotencyKey: "coordination-run",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: sourceKey,
          sourceTool: "sessions_send",
          sourceRole: "subagent",
        },
      });
      expect(result?.inputProvenance?.sourceRole).toBe(expectedRole);
    },
  );

  it("rejects malformed and non-object structured output schemas", async () => {
    for (const schema of [
      { type: "array", items: { type: "string" } },
      { type: "object", properties: "invalid" },
    ]) {
      expectRejected(await runPreflight(schema));
    }
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

  it("rejects unregistered or non-backend collector requests", async () => {
    const schema = { type: "object" };
    for (const options of [
      { enabled: true, backend: true, register: false },
      { enabled: true, backend: false, register: true },
    ]) {
      expectRejected(await runPreflight(schema, true, options));
      subagentRuns.clear();
    }
  });

  it("rejects ordinary turns and mismatched launch identities for an active collector", async () => {
    for (const options of [
      { includeCollectorFields: false },
      { idempotencyKey: "different-launch" },
    ]) {
      expectRejected(await runCollector(options));
      subagentRuns.clear();
    }
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

  it("rejects a terminal collector even when its pending launch flag remains set", async () => {
    expectRejected(await runCollector({ ended: true }));
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
  async function runRestartRecoveryPreflight(
    backend: boolean,
    sourceTool: string,
    internalExecutionIdentityRetry?: boolean,
    internalExecutionIdentityRecoveryAttempt?: number,
  ) {
    return runRequest(
      {
        message: "continue",
        idempotencyKey: "restart-recovery-run",
        forceRestartSafeTools: true,
        forceCodeModeTools: true,
        ...(internalExecutionIdentityRetry !== undefined ? { internalExecutionIdentityRetry } : {}),
        ...(internalExecutionIdentityRecoveryAttempt !== undefined
          ? { internalExecutionIdentityRecoveryAttempt }
          : {}),
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: "agent:main:main",
          sourceTool,
        },
      },
      undefined,
      backend,
    );
  }

  it("accepts the Code Mode override only for backend restart recovery", async () => {
    const accepted = await runRestartRecoveryPreflight(
      true,
      "main_session_restart_recovery",
      true,
      1,
    );

    expect(accepted.result).toBeDefined();
    expect(accepted.respond).not.toHaveBeenCalled();
  });

  it("rejects private execution retry mode outside backend restart recovery", async () => {
    const rejected = await runRestartRecoveryPreflight(
      false,
      "main_session_restart_recovery",
      true,
      1,
    );

    expectRejected(rejected, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("execution identity recovery fields"),
    });
  });

  it.each([
    { backend: false, sourceTool: "main_session_restart_recovery" },
    { backend: true, sourceTool: "other_internal_source" },
  ])("rejects an untrusted Code Mode override", async ({ backend, sourceTool }) => {
    const rejected = await runRestartRecoveryPreflight(backend, sourceTool);

    expectRejected(rejected, {
      code: "INVALID_REQUEST",
      message: "forceCodeModeTools is reserved for main-session restart recovery.",
    });
  });
});

describe("agent request session ownership preflight", () => {
  async function runBareSessionPreflight(owner?: string) {
    return runRequest(
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
  }

  it("admits a bare key owned by the configured fixed store", async () => {
    const { respond, result } = await runBareSessionPreflight("ops");

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects an ownerless bare key with a typed selection error", async () => {
    expectRejected(await runBareSessionPreflight(), {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
  });
});
