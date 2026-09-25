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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { installTestApprovalClock } from "./exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "./worker-environments/placement-turn-claim-events.js";

type GatewayAux = ReturnType<typeof createGatewayAuxHandlers>;
type GatewayAuxParams = Parameters<typeof createGatewayAuxHandlers>[0];
const auxiliaries: GatewayAux[] = [];
let fixture: OpenClawTestState | undefined;

function createAuthorityHarness(
  params: Pick<
    GatewayAuxParams,
    | "onApprovalLifecycle"
    | "onAgentRunAuthorityClosed"
    | "validateAgentRuntimeDelegatedAuthority"
    | "registerWorkerTurnClaimClosedHandler"
  > = {},
): GatewayAux {
  const aux = createGatewayAuxHandlers({
    log: {},
    getNativeApprovalRouteCoordinator: () => undefined,
    activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    clients: [],
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: () => {} },
    ...params,
  });
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
  it("shares one approval epoch per gateway lifetime and rotates it on restart", () => {
    const first = createAuthorityHarness({});
    const second = createAuthorityHarness({});

    expect(first.execApprovalManager.runtimeEpoch).toBe(first.pluginApprovalManager.runtimeEpoch);
    expect(second.execApprovalManager.runtimeEpoch).toBe(second.pluginApprovalManager.runtimeEpoch);
    expect(first.execApprovalManager.runtimeEpoch).not.toBe(
      second.execApprovalManager.runtimeEpoch,
    );
  });

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
    const record = gatewayAux.execApprovalManager.create({ command: "echo pending" }, 60_000);
    record.agentRuntimeDelegatedAuthority = { ...authority, kind: "local" };
    await gatewayAux.execApprovalManager.register(record, 60_000);
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
      const record = gatewayAux.execApprovalManager.create({ command: "echo old" }, 2_000);
      record.agentRuntimeDelegatedAuthority = { ...scoped, kind: "local" };
      const pending = (await gatewayAux.execApprovalManager.register(record, 2_000)).decision;

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
      vi.fn<
        (
          authority: ReturnType<typeof claimAgentRunDelegatedAuthority>,
          approvalReason?: string,
        ) => void
      >();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    gatewayAux.bindApprovalPublicationContext({
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      approvalEvents: { publishResolved },
      logGateway: { error: vi.fn() },
    } as never);
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
        const record = gatewayAux.pluginApprovalManager.create(
          { title: `Request ${index}`, description: "Independent native approval" },
          60_000,
        );
        record.agentRuntimeDelegatedAuthority = { ...scoped, kind: "local" };
        const decision = (await gatewayAux.pluginApprovalManager.register(record, 60_000)).decision;
        return { record, decision };
      }),
    );
    try {
      first.abort();
      await expect(records[0]!.decision).resolves.toBeNull();
      expect(await getOperatorApprovalDetailed({ id: records[0]!.record.id })).toMatchObject({
        outcome: "found",
        record: { status: "cancelled", terminalReason: "run-aborted" },
      });
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(publishResolved).toHaveBeenCalledWith(
        "plugin",
        expect.objectContaining({ id: records[0]!.record.id }),
      );
      expect(await getOperatorApprovalDetailed({ id: records[1]!.record.id })).toMatchObject({
        outcome: "found",
        record: { status: "pending" },
      });
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
      const onAgentRunAuthorityClosed = vi.fn();
      const gatewayAux = createAuthorityHarness({
        onAgentRunAuthorityClosed,
      });
      const operationalRunInstance = Object.freeze({
        instanceId: "egress-proxy-instance",
        runId: "egress-proxy-run",
      });
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const onResolved = vi.fn();
      const question = gatewayAux.questionManager.request({
        questions: [
          {
            questionId: "key",
            header: "Key",
            question: "Credential",
            options: [],
            isSecret: true,
            secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
          },
        ],
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
        await expect(answer).resolves.toEqual({ status: "cancelled" });
        expect(onAgentRunAuthorityClosed).toHaveBeenCalledOnce();
        expect(onAgentRunAuthorityClosed).toHaveBeenCalledWith(
          expect.objectContaining({ operationalRunInstance }),
          undefined,
        );
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
        questions: [
          {
            questionId: "key",
            header: "Key",
            question: "Credential",
            options: [],
            isSecret: true,
            secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
          },
        ],
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
      const broadcast = vi.fn();
      const publishResolved = vi.fn();
      const handleWebPushExpired = vi.spyOn(gatewayAux.approvalWebPushDelivery, "handleExpired");
      gatewayAux.bindApprovalPublicationContext({
        broadcast,
        broadcastToConnIds: vi.fn(),
        approvalEvents: { publishResolved },
        approvalWebPushDelivery: gatewayAux.approvalWebPushDelivery,
        logGateway: { error: vi.fn() },
      } as never);
      const record = gatewayAux.execApprovalManager.create(
        { command: "echo expires" },
        1_000,
        "exec-timeout-publish",
      );
      const decision = (await gatewayAux.execApprovalManager.register(record, 1_000)).decision;

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(decision).resolves.toBeNull();
      // The gateway clock owns expiry: reviewer surfaces must receive the
      // terminal event instead of pruning on their own (skewed) clocks.
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(handleWebPushExpired).toHaveBeenCalledWith(
        expect.objectContaining({ id: "exec-timeout-publish" }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        "exec.approval.resolved",
        expect.objectContaining({ id: "exec-timeout-publish", decision: "deny" }),
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
    seedAttachedPlacementEnvironment(database, {
      environmentId: "worker-env",
      sessionId: identity.sessionId,
      ownerEpoch: 7,
    });
    let placement = placements.startDispatch(identity);
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "worker-env" },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/workspace/worker-close",
      },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: 7 },
    });
    if (placement.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const operationalRunInstance = Object.freeze({
      instanceId: "worker-operational-instance",
      runId: "worker-run-close",
    });
    const runAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = placements.claimTurn({
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
    const lifecycle = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onApprovalLifecycle: lifecycle,
      validateAgentRuntimeDelegatedAuthority: (candidate) =>
        validateAuthority({
          kind: "agentRuntime",
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          operationalRunInstance: candidate.operationalRunInstance,
          delegatedAuthority: candidate,
        }),
      registerWorkerTurnClaimClosedHandler: (handler) =>
        placements.registerTurnClaimClosedHandler(handler),
    });
    const broadcast = vi.fn();
    const publishResolved = vi.fn();
    gatewayAux.bindApprovalPublicationContext({
      broadcast,
      broadcastToConnIds: vi.fn(),
      approvalEvents: { publishResolved },
      logGateway: { error: vi.fn() },
    } as never);
    const execRecord = gatewayAux.execApprovalManager.create(
      { command: "echo worker", runId: turnClaim.runId },
      60_000,
      "exec-worker-close",
    );
    execRecord.agentRuntimeDelegatedAuthority = authority;
    const execDecision = (await gatewayAux.execApprovalManager.register(execRecord, 60_000))
      .decision;
    const pluginRecord = gatewayAux.pluginApprovalManager.create(
      { title: "Worker action", description: "Close with worker claim", runId: turnClaim.runId },
      60_000,
      "plugin-worker-close",
    );
    pluginRecord.agentRuntimeDelegatedAuthority = authority;
    const pluginDecision = (await gatewayAux.pluginApprovalManager.register(pluginRecord, 60_000))
      .decision;
    const questionResolved = vi.fn();
    const question = gatewayAux.questionManager.request({
      questions: [
        {
          questionId: "key",
          header: "Key",
          question: "Credential",
          options: [],
          isSecret: true,
          secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
        },
      ],
      timeoutMs: 60_000,
      isRequesterActive: () =>
        validateAuthority({
          kind: "agentRuntime",
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          operationalRunInstance,
          delegatedAuthority: authority,
        }),
      onResolved: questionResolved,
    });

    for (const record of [execRecord, pluginRecord]) {
      expect(await getOperatorApprovalDetailed({ id: record.id })).toMatchObject({
        outcome: "found",
        record: { status: "pending" },
      });
    }
    expect(questionResolved).not.toHaveBeenCalled();
    expect(publishResolved).not.toHaveBeenCalled();

    placements.releaseTurn(turnClaim);

    expect(questionResolved).toHaveBeenCalledExactlyOnceWith(
      { id: question.id, status: "cancelled" },
      {
        record: { ...question, status: "cancelled", resolvedBy: "requester-inactive" },
        ordinary: false,
        sessionAccess: undefined,
        isCurrent: expect.any(Function),
        refreshRequester: expect.any(Function),
      },
    );
    expect(questionResolved.mock.calls[0]?.[1].isCurrent()).toBe(true);
    await expect(execDecision).resolves.toBeNull();
    await expect(pluginDecision).resolves.toBeNull();
    await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(2));
    expect(publishResolved.mock.calls.map((call) => call[0])).toEqual(["exec", "plugin"]);
    expect(broadcast.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.resolved",
      "plugin.approval.resolved",
    ]);
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "exec", status: "cancelled" }),
      }),
    );
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "plugin", status: "cancelled" }),
      }),
    );
    await gatewayAux.stopOperatorInteractions();
    releaseAgentRunDelegatedAuthority(runAuthority);
  });
});
