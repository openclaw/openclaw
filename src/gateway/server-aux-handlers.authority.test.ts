// Exercises the Gateway-owned authority observer, without loading lazy RPC handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import type { AgentRuntimeDelegatedAuthority } from "./agent-runtime-identity-token.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { installTestApprovalClock } from "./exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createGatewayAuxHandlerTestParams } from "./server-aux-handlers.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "./worker-environments/placement-turn-claim-events.js";

type GatewayAux = ReturnType<typeof createGatewayAuxHandlers>;
type GatewayAuxParams = Parameters<typeof createGatewayAuxHandlers>[0];
const auxiliaries: GatewayAux[] = [];
let fixture: OpenClawTestState | undefined;
const credentialQuestions = [
  {
    questionId: "key",
    header: "Key",
    question: "Credential",
    options: [],
    isSecret: true,
    secretStore: { name: "SERVICE_API_KEY", kind: "secret" as const },
  },
];

function bindPublication(gatewayAux: GatewayAux, withWebPush = false) {
  const broadcast = vi.fn();
  const publishResolved = vi.fn();
  gatewayAux.bindApprovalPublicationContext({
    broadcast,
    broadcastToConnIds: vi.fn(),
    approvalEvents: { publishResolved },
    ...(withWebPush ? { approvalWebPushDelivery: gatewayAux.approvalWebPushDelivery } : {}),
    logGateway: { error: vi.fn() },
  } as never);
  return { broadcast, publishResolved };
}

function expectQuestionCancelled(
  onResolved: ReturnType<typeof vi.fn>,
  question: ReturnType<GatewayAux["questionManager"]["request"]>,
) {
  expect(onResolved).toHaveBeenCalledExactlyOnceWith(
    { id: question.id, status: "cancelled" },
    {
      record: { ...question, status: "cancelled", resolvedBy: "requester-inactive" },
      ordinary: false,
      sessionAccess: undefined,
      isCurrent: expect.any(Function),
      refreshRequester: expect.any(Function),
    },
  );
  expect(onResolved.mock.calls[0]?.[1].isCurrent()).toBe(true);
}

async function expectApproval(id: string, record: Record<string, unknown>) {
  expect(await getOperatorApprovalDetailed({ id })).toMatchObject({ outcome: "found", record });
}

async function registerApproval<T>(
  manager: ExecApprovalManager<T>,
  request: T,
  authority?: AgentRuntimeDelegatedAuthority,
  timeoutMs = 60_000,
) {
  const record = manager.create(request, timeoutMs);
  if (authority) {
    record.agentRuntimeDelegatedAuthority = authority;
  }
  return { record, ...(await manager.register(record, timeoutMs)) };
}

function createAuthorityHarness(
  params: Pick<
    GatewayAuxParams,
    | "onApprovalLifecycle"
    | "onAgentRunAuthorityClosed"
    | "validateAgentRuntimeDelegatedAuthority"
    | "registerWorkerTurnClaimClosedHandler"
  > = {},
): GatewayAux {
  const aux = createGatewayAuxHandlers(
    createGatewayAuxHandlerTestParams({
      scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
      ...params,
    }),
  );
  auxiliaries.push(aux);
  return aux;
}

beforeEach(async () => {
  if (fixture) {
    throw new Error("Previous auxiliary owner cleanup did not finish");
  }
  fixture = await createOpenClawTestState({ label: "gateway-aux-authority" });
});

afterEach(async () => {
  for (const aux of auxiliaries) {
    await aux.stopOperatorInteractions();
  }
  auxiliaries.length = 0;
  resetAgentRunRegistryForTest();
  await fixture?.cleanup();
  fixture = undefined;
});

describe("gateway auxiliary authority lifecycle", () => {
  it("leaves durable approval truth pending when authority closes after owner stop", async () => {
    const onAgentRunAuthorityClosed = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "stopped-approval-owner",
      runId: "stopped-approval-run",
    });
    const { record } = await registerApproval(
      gatewayAux.execApprovalManager,
      { command: "echo pending" },
      { ...authority, kind: "local" },
    );
    const pending = await getOperatorApprovalDetailed({ id: record.id });
    expect(pending).toMatchObject({
      outcome: "found",
      record: { status: "pending", decision: null, resolvedAtMs: null },
    });
    const observerClosed = expect(
      gatewayAux.execApprovalManager.awaitDecision(record.id),
    ).rejects.toBeInstanceOf(ApprovalObserverClosedError);

    gatewayAux.beginCloseApprovalObservers();
    await observerClosed;
    await gatewayAux.stopOperatorInteractions();
    releaseAgentRunDelegatedAuthority(authority);

    expect(onAgentRunAuthorityClosed).not.toHaveBeenCalled();
    expect(await getOperatorApprovalDetailed({ id: record.id })).toEqual(pending);
  });

  it("reports scoped authority closure separately from whole-run capability closure", async () => {
    const onAgentRunAuthorityClosed = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    vi.useFakeTimers();
    const restoreClock = installTestApprovalClock();
    try {
      const operationalRunInstance = Object.freeze({
        instanceId: "egress-proxy-instance",
        runId: "egress-proxy-run",
      });
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const generation = new AbortController();
      const scoped = claimAgentRunApprovalAuthority(authority, [generation.signal]);
      const { record, decision: pending } = await registerApproval(
        gatewayAux.execApprovalManager,
        { command: "echo old" },
        { ...scoped, kind: "local" },
        2_000,
      );

      generation.abort();

      await expect(pending).resolves.toBeNull();
      expect((await gatewayAux.execApprovalManager.getSnapshot(record.id))?.status).toBe(
        "cancelled",
      );
      expect(onAgentRunAuthorityClosed).toHaveBeenCalledExactlyOnceWith(
        scoped,
        "approval-scope-closed",
      );
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);

      releaseAgentRunDelegatedAuthority(authority);

      expect(onAgentRunAuthorityClosed).toHaveBeenCalledTimes(2);
      expect(onAgentRunAuthorityClosed).toHaveBeenLastCalledWith(
        expect.objectContaining({ operationalRunInstance }),
        undefined,
      );
    } finally {
      try {
        await gatewayAux.stopOperatorInteractions();
      } finally {
        restoreClock?.();
        vi.useRealTimers();
      }
    }
  });

  it("retires one request approval while its sibling and admitted run remain live", async () => {
    const onAgentRunAuthorityClosed =
      vi.fn<NonNullable<GatewayAuxParams["onAgentRunAuthorityClosed"]>>();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const { publishResolved } = bindPublication(gatewayAux);
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "native-permission-owner",
      runId: "native-permission-run",
    });
    const host = new AbortController();
    const first = new AbortController();
    const second = new AbortController();
    const records = await Promise.all(
      [first, second].map(async (request, index) => {
        const scoped = claimAgentRunApprovalAuthority(authority, [host.signal, request.signal]);
        return registerApproval(
          gatewayAux.pluginApprovalManager,
          { title: `Request ${index}`, description: "Independent native approval" },
          { ...scoped, kind: "local" },
        );
      }),
    );
    try {
      first.abort();
      await expect(records[0]!.decision).resolves.toBeNull();
      await expectApproval(records[0]!.record.id, {
        status: "cancelled",
        terminalReason: "run-aborted",
      });
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(publishResolved).toHaveBeenCalledWith(
        "plugin",
        expect.objectContaining({ id: records[0]!.record.id }),
      );
      await expectApproval(records[1]!.record.id, { status: "pending" });
      // Scoped approval notifications do not retire whole-run capabilities.
      expect(
        onAgentRunAuthorityClosed.mock.calls.filter(
          ([, approvalReason]) => approvalReason === undefined,
        ),
      ).toEqual([]);
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      expect(
        await gatewayAux.pluginApprovalManager.resolve(
          records[1]!.record.id,
          "allow-once",
          "fixture reviewer",
        ),
      ).toBe(true);
      await expect(records[1]!.decision).resolves.toBe("allow-once");
    } finally {
      host.abort();
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it.each(["release", "replacement", "generation"] as const)(
    "settles credential questions on authority %s without waiting for a read",
    async (closure) => {
      const gatewayAux = createAuthorityHarness();
      const operationalRunInstance = Object.freeze({
        instanceId: "egress-proxy-instance",
        runId: "egress-proxy-run",
      });
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const onResolved = vi.fn();
      const question = gatewayAux.questionManager.request({
        questions: credentialQuestions,
        timeoutMs: 60_000,
        isRequesterActive: () => validateAgentRunDelegatedAuthority(authority),
        onResolved,
      });
      const answer = gatewayAux.questionManager.waitAnswer(question.id);
      let replacement: typeof authority | undefined;
      try {
        if (closure === "release") {
          releaseAgentRunDelegatedAuthority(authority);
        } else if (closure === "replacement") {
          replacement = claimAgentRunDelegatedAuthority({
            ...operationalRunInstance,
            instanceId: "replacement",
          });
        } else {
          rotateAgentRunRegistryLifecycleGeneration();
        }
        // get/list also check liveness, so assert push delivery before either read.
        expectQuestionCancelled(onResolved, question);
        await expect(answer).resolves.toEqual({ status: "cancelled" });
      } finally {
        await gatewayAux.stopOperatorInteractions();
        const remaining = replacement ?? authority;
        releaseAgentRunContext(remaining.operationalRunInstance.runId, remaining.claimId);
      }
    },
  );

  it("keeps reentrant question callbacks from losing another authority closure", async () => {
    const gatewayAux = createAuthorityHarness({});
    const authorities = ["first", "second", "live"].map((id) =>
      claimAgentRunDelegatedAuthority({ runId: `question-${id}`, instanceId: id }),
    );
    const events: string[] = [];
    const questions = authorities.map((authority, index) =>
      gatewayAux.questionManager.request({
        id: authority.operationalRunInstance.instanceId,
        questions: credentialQuestions,
        timeoutMs: 60_000,
        isRequesterActive: () => validateAgentRunDelegatedAuthority(authority),
        onResolved: (event) => {
          events.push(event.id);
          if (index === 0) {
            releaseAgentRunDelegatedAuthority(authorities[1]!);
          }
        },
      }),
    );
    const answers = questions
      .slice(0, 2)
      .map((question) => gatewayAux.questionManager.waitAnswer(question.id));
    try {
      releaseAgentRunDelegatedAuthority(authorities[0]!);
      expect(events).toEqual(["first", "second"]);
      await expect(Promise.all(answers)).resolves.toEqual([
        { status: "cancelled" },
        { status: "cancelled" },
      ]);
      expect(gatewayAux.questionManager.list().map((question) => question.id)).toEqual(["live"]);
    } finally {
      await gatewayAux.stopOperatorInteractions();
      authorities.forEach(releaseAgentRunDelegatedAuthority);
    }
  });

  it("publishes exec.approval.resolved when the gateway timeout expires an approval", async () => {
    vi.useFakeTimers();
    const restoreClock = installTestApprovalClock();
    try {
      const gatewayAux = createAuthorityHarness({});
      const handleWebPushExpired = vi.spyOn(gatewayAux.approvalWebPushDelivery, "handleExpired");
      const { broadcast, publishResolved } = bindPublication(gatewayAux, true);
      const { record, decision } = await registerApproval(
        gatewayAux.execApprovalManager,
        { command: "echo expires" },
        undefined,
        1_000,
      );

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(decision).resolves.toBeNull();
      // The gateway clock owns expiry: reviewer surfaces must receive the
      // terminal event instead of pruning on their own (skewed) clocks.
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(handleWebPushExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
      expect(broadcast).toHaveBeenCalledWith(
        "exec.approval.resolved",
        expect.objectContaining({ id: record.id, decision: "deny" }),
        expect.anything(),
      );
      await gatewayAux.stopOperatorInteractions();
    } finally {
      restoreClock?.();
      vi.useRealTimers();
    }
  });

  it("settles and publishes both approval kinds from the production worker-claim observer", async () => {
    if (!fixture) {
      throw new Error("expected Gateway authority fixture");
    }
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const identity = {
      sessionId: "session-worker-close",
      agentId: "main",
      sessionKey: "agent:main:worker-close",
    };
    const placement = await advancePlacementFixtureToActive(placements, database, identity, {
      environmentId: "worker-env",
      remoteWorkspaceDir: "/workspace/worker-close",
      seedEnvironment: "before-dispatch",
    });
    const operationalRunInstance = Object.freeze({
      instanceId: "worker-operational-instance",
      runId: "worker-run-close",
    });
    const runAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = await placements.claimTurn({
      ...identity,
      claimId: "worker-claim-close",
      runId: operationalRunInstance.runId,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
    });
    const { capability } = await bindWorkerTurnOwner(
      placements,
      turnClaim,
      undefined,
      operationalRunInstance,
      { ...identity, storePath: fixture.statePath("agents", "main", "sessions", "sessions.json") },
      () => {},
    );
    const authority = await capability.run((owner) => ({
      kind: "worker" as const,
      ...owner.delegatedAuthority,
      turnClaim: owner.turnClaim,
    }));
    const validateAuthority = createAgentRuntimeApprovalAuthorityValidator(placements);
    const validateDelegated = (candidate: AgentRuntimeDelegatedAuthority) =>
      validateAuthority({
        kind: "agentRuntime",
        ...identity,
        operationalRunInstance: candidate.operationalRunInstance,
        delegatedAuthority: candidate,
      });
    const gatewayAux = createAuthorityHarness({
      validateAgentRuntimeDelegatedAuthority: validateDelegated,
      registerWorkerTurnClaimClosedHandler: (handler) =>
        placements.registerTurnClaimClosedHandler(handler),
    });
    const { broadcast } = bindPublication(gatewayAux);
    const { record: execRecord, decision: execDecision } = await registerApproval(
      gatewayAux.execApprovalManager,
      { command: "echo worker", runId: turnClaim.runId },
      authority,
    );
    const { record: pluginRecord, decision: pluginDecision } = await registerApproval(
      gatewayAux.pluginApprovalManager,
      { title: "Worker action", description: "Close with worker claim", runId: turnClaim.runId },
      authority,
    );
    const questionResolved = vi.fn();
    const question = gatewayAux.questionManager.request({
      questions: credentialQuestions,
      timeoutMs: 60_000,
      isRequesterActive: () => validateDelegated(authority),
      onResolved: questionResolved,
    });

    for (const record of [execRecord, pluginRecord]) {
      await expectApproval(record.id, { status: "pending" });
    }
    expect(questionResolved).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    await placements.releaseTurn(turnClaim);

    expectQuestionCancelled(questionResolved, question);
    await expect(execDecision).resolves.toBeNull();
    await expect(pluginDecision).resolves.toBeNull();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
    expect(broadcast.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.resolved",
      "plugin.approval.resolved",
    ]);
    for (const record of [execRecord, pluginRecord]) {
      await expectApproval(record.id, { status: "cancelled" });
    }
    await gatewayAux.stopOperatorInteractions();
    releaseAgentRunDelegatedAuthority(runAuthority);
  });
});
