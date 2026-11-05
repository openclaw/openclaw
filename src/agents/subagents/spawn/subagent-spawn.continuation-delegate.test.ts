import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveContinuationDelegateChildRunId,
  deriveContinuationDelegateChildSessionKey,
} from "../../subagent-continuation-ids.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import { closeSwarmScheduler } from "../swarm/swarm-scheduler.js";
import {
  SpawnSubagentAdmissionCancelledError,
  type SpawnSubagentAdmissionAuthority,
} from "./subagent-spawn-contract.js";
import {
  createConfigOverride,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupCommittedSubagentRegistrationMock,
  supportedSpawnModelChoice,
} from "./subagent-spawn.test-helpers.js";

type SpawnSubagentAdmissionBoundary = Parameters<
  SpawnSubagentAdmissionAuthority["assertCurrent"]
>[0];

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  recordAcceptedSubagentSpawnRollbackMock: vi.fn(),
  rollbackSubagentRunRegistrationMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  completeCollectorLaunchCleanupMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  dispatchGatewayMethodInProcessMock: vi.fn(),
  hasInProcessGatewayContextMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  resolveContextEngineMock: vi.fn(),
  countActiveRunsForSessionMock: vi.fn(),
  listSwarmRunsForGroupMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn<
    (params: { sessionKey?: string }) => {
      sandboxed: boolean;
      sandboxRequired: boolean;
      isolationSubject?: import("../../sandbox/types.js").SandboxIsolationSubject;
      createdActor?: import("../../../config/sessions/session-entry-provenance.js").SessionCreatedActor;
    }
  >(),
}));

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function gatewayRequestRecords(): Record<string, unknown>[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}

function expectNoChildSpawnSideEffects(): void {
  expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
}

function createDelegateAdmissionAuthority(
  options: { resetAfter?: SpawnSubagentAdmissionBoundary } = {},
): {
  authority: SpawnSubagentAdmissionAuthority;
  boundaries: SpawnSubagentAdmissionBoundary[];
  controller: AbortController;
} {
  const controller = new AbortController();
  const boundaries: SpawnSubagentAdmissionBoundary[] = [];
  return {
    controller,
    boundaries,
    authority: {
      signal: controller.signal,
      source: {
        ownerSessionKey: "agent:main:main",
        flowId: "delegate-flow",
        expectedRevision: 1,
      },
      assertCurrent(boundary) {
        boundaries.push(boundary);
        if (controller.signal.aborted) {
          throw new SpawnSubagentAdmissionCancelledError("delegate reset");
        }
        if (boundary === options.resetAfter) {
          controller.abort("session-reset");
        }
      },
    },
  };
}

describe("spawnSubagentDirect continuation delegate seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      ...hoisted,
      getRuntimeConfig: () => configOverride,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
      listSwarmRunsForGroup: hoisted.listSwarmRunsForGroupMock,
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
  });

  beforeEach(async () => {
    await closeSwarmScheduler();
    await resetSubagentRegistryForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.prepareModelChoiceMock.mockImplementation(supportedSpawnModelChoice);
    setupCommittedSubagentRegistrationMock(hoisted.registerSubagentRunMock);
    hoisted.recordAcceptedSubagentSpawnRollbackMock.mockReturnValue({ status: "persisted" });
    hoisted.rollbackSubagentRunRegistrationMock.mockReturnValue(true);
    hoisted.startQueuedSubagentRunMock.mockReturnValue(true);
    hoisted.settleFailedQueuedSubagentLaunchMock.mockReturnValue(true);
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(false);
    hoisted.resolveContextEngineMock.mockResolvedValue({});
    hoisted.countActiveRunsForSessionMock.mockReturnValue(0);
    hoisted.listSwarmRunsForGroupMock.mockReturnValue([]);
    hoisted.resolveSandboxRuntimeStatusMock.mockReturnValue({
      sandboxed: false,
      sandboxRequired: false,
    });
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.loadSessionStoreMock.mockReturnValue({});

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  afterEach(async () => {
    await closeSwarmScheduler();
    vi.unstubAllEnvs();
  });
  it("admits no child side effect when delegate authority closes after planning", async () => {
    let releasePlanning!: () => void;
    let planningReached!: () => void;
    const reachedPlanning = new Promise<void>((resolve) => {
      planningReached = resolve;
    });
    const planningBarrier = new Promise<void>((resolve) => {
      releasePlanning = resolve;
    });
    // Model-choice resolution is the planning-phase seam upstream kept after
    // retiring the prepared-catalog mock; barrier there to close authority
    // mid-planning, before any child admission.
    hoisted.prepareModelChoiceMock.mockImplementationOnce(async (request) => {
      planningReached();
      await planningBarrier;
      return await supportedSpawnModelChoice(request);
    });
    const admission = createDelegateAdmissionAuthority();

    const pending = spawnSubagentDirect(
      { task: "cancel before child admission", model: "openai/gpt-5.4" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );
    await reachedPlanning;
    admission.controller.abort("session-reset");
    releasePlanning();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      error: "delegate reset",
    });
    expect(admission.boundaries).toEqual(["child-session"]);
    expectNoChildSpawnSideEffects();
  });

  it("rolls back an accepted Gateway child when delegate authority closes before registration", async () => {
    let releaseGateway!: () => void;
    let gatewayReached!: () => void;
    const reachedGateway = new Promise<void>((resolve) => {
      gatewayReached = resolve;
    });
    const gatewayBarrier = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        gatewayReached();
        await gatewayBarrier;
        return { runId: "late-child-run" };
      }
      if (request.method === "chat.abort") {
        return { ok: true, aborted: true, runIds: ["late-child-run"] };
      }
      return { ok: true };
    });
    const admission = createDelegateAdmissionAuthority();

    const pending = spawnSubagentDirect(
      { task: "cancel after Gateway acceptance" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );
    await reachedGateway;
    admission.controller.abort("session-reset");
    releaseGateway();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      childSessionKey: expect.any(String),
      runId: "late-child-run",
    });
    expect(admission.boundaries).toEqual([
      "child-session",
      "gateway-dispatch",
      "registry-acceptance",
    ]);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(gatewayRequestRecords().map((request) => request.method)).toContain("chat.abort");
    expect(gatewayRequestRecords().map((request) => request.method)).toContain("sessions.delete");
  });

  it("rolls back an accepted child when reset lands after lifecycle publication", async () => {
    const admission = createDelegateAdmissionAuthority({ resetAfter: "lifecycle-publication" });

    const result = await spawnSubagentDirect(
      { task: "cancel after publication" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );

    expect(result).toMatchObject({
      status: "cancelled",
      childSessionKey: expect.any(String),
      runId: "run-1",
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledOnce();
    const registered = firstRegisteredSubagentRun();
    expect(hoisted.rollbackSubagentRunRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        childSessionKey: registered.childSessionKey,
      }),
    );
    expect(gatewayRequestRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "chat.abort",
          params: expect.objectContaining({ runId: "run-1" }),
        }),
      ]),
    );
    expect(admission.boundaries).toEqual([
      "child-session",
      "gateway-dispatch",
      "registry-acceptance",
      "lifecycle-publication",
      "final-acceptance",
    ]);
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
  });

  it("terminates after rollback-owner persistence fails and preserves cancellation", async () => {
    const admission = createDelegateAdmissionAuthority({ resetAfter: "lifecycle-publication" });
    hoisted.recordAcceptedSubagentSpawnRollbackMock.mockReturnValueOnce({
      status: "pending-persistence",
      error: new Error("rollback owner disk full"),
    });

    const result = await spawnSubagentDirect(
      { task: "cancel after rollback persistence failure" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );

    expect(result).toMatchObject({
      status: "cancelled",
      runId: "run-1",
      error: expect.stringContaining("post-registration rollback incomplete"),
    });
    expect(gatewayRequestRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "chat.abort",
          params: expect.objectContaining({ runId: "run-1" }),
        }),
      ]),
    );
    expect(hoisted.rollbackSubagentRunRegistrationMock).toHaveBeenCalledOnce();
  });

  it("keeps exact rollback ownership when persistence and termination both fail", async () => {
    const admission = createDelegateAdmissionAuthority({ resetAfter: "lifecycle-publication" });
    hoisted.updateSessionStoreMock.mockImplementation(async () => ({}));
    hoisted.recordAcceptedSubagentSpawnRollbackMock.mockReturnValueOnce({
      status: "pending-persistence",
      error: new Error("rollback owner disk full"),
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-rollback-incomplete" };
      }
      if (request.method === "chat.abort") {
        return { aborted: true, runIds: ["different-run"] };
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      { task: "retain rollback retry owner" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );

    expect(result).toMatchObject({
      status: "cancelled",
      runId: "run-rollback-incomplete",
      error: expect.stringContaining("post-registration rollback incomplete"),
    });
    expect(hoisted.recordAcceptedSubagentSpawnRollbackMock).toHaveBeenCalledOnce();
    expect(hoisted.rollbackSubagentRunRegistrationMock).not.toHaveBeenCalled();
    expect(gatewayRequestRecords().map((request) => request.method)).toContain("chat.abort");
  });

  // H1 §3.2 (absorb 14fe10d0): the deferred final acceptance owner receives the
  // pipeline's rollback handle (previously dropped here, making post-accept
  // rollbacks no-ops) plus its confirm handle, and the child is armed at registration.
  it("threads the accepted rollback and confirm handles to the deferred acceptance owner", async () => {
    const admission = createDelegateAdmissionAuthority();
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-deferred-acceptance" };
      }
      if (request.method === "chat.abort") {
        return { aborted: true, runIds: ["run-deferred-acceptance"] };
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      { task: "deferred final acceptance" },
      {
        agentSessionKey: "agent:main:main",
        continuationDelegateAdmission: admission.authority,
      },
    );

    expect(result).toMatchObject({ status: "accepted", runId: "run-deferred-acceptance" });
    expect(firstRegisteredSubagentRun()).toMatchObject({
      acceptanceCustody: { gatewayRunId: "run-deferred-acceptance" },
    });
    expect(result.rollbackAccepted).toBeTypeOf("function");
    expect(result.confirmAccepted).toBeTypeOf("function");
    expect(result.releaseAcceptanceHold).toBeTypeOf("function");

    await result.rollbackAccepted!();
    expect(hoisted.recordAcceptedSubagentSpawnRollbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-deferred-acceptance",
        gatewayRunId: "run-deferred-acceptance",
      }),
    );
    // Termination authority lives in the registration scope this seam mocks out;
    // the real abort after a post-accept rollback is covered end to end by T8.
    expect(hoisted.rollbackSubagentRunRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-deferred-acceptance" }),
    );
  });

  it("preserves continuation flow identity for the child run and session", async () => {
    const flowId = "flow-after-swarm-merge";
    const result = await spawnSubagentDirect(
      {
        task: "resume the durable continuation",
        continuationDelegateFlowId: flowId,
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: deriveContinuationDelegateChildSessionKey("main", flowId),
    });
    expect(firstRegisteredSubagentRun()).toMatchObject({
      runId: result.runId,
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(requireRecord(gatewayRequest("agent").params).idempotencyKey).toBe(
      deriveContinuationDelegateChildRunId(flowId),
    );
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    const admission = createDelegateAdmissionAuthority();

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai/gpt-5.4",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        drainsContinuationDelegateQueue: true,
        continuationChainState: {
          count: 7,
          startedAt: 1_783_520_000_000,
          tokens: 12_345,
          chainId: "chain-from-parent",
        },
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
        continuationDelegateAdmission: admission.authority,
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe("run-1");
    expect(result.mode).toBe("run");
    expect(result.expectsCompletionMessage).toBe(true);
    expect(result.modelApplied).toBe(true);
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledOnce();
    expect(persistedStore?.[childSessionKey]).toMatchObject({
      sessionId: expect.any(String),
      lifecycleRevision: expect.any(String),
      spawnedBy: "agent:main:main",
      completionOwnerSessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "main" },
      createdAt: expect.any(Number),
      model: "gpt-5.4",
      modelProvider: "openai",
      modelOverride: "gpt-5.4",
      providerOverride: "openai",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      continuationTraceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      continuationChainCount: 7,
      continuationChainStartedAt: 1_783_520_000_000,
      continuationChainTokens: 12_345,
      continuationChainId: "chain-from-parent",
    });
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(registerInput.runId).toBe("run-1");
    expect(registerInput.childSessionKey).toBe(childSessionKey);
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin.threadId).toBe(42);
    expect(registerInput.task).toBe("inspect the spawn seam");
    expect(registerInput.cleanup).toBe("keep");
    expect(registerInput.model).toBe("openai/gpt-5.4");
    expect(registerInput.workspaceDir).toBe("/tmp/requester-workspace");
    expect(registerInput.expectsCompletionMessage).toBe(true);
    expect(registerInput.spawnMode).toBe("run");
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledOnce();
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentRequest.scopes).toEqual(["operator.admin"]);
    expect(agentParams.sessionKey).toBe(childSessionKey);
    expect(agentParams.provider).toBe("openai");
    expect(agentParams.model).toBe("gpt-5.4");
    expect(agentParams.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("persists inherited continuation chain state into draining child sessions", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "drain continuation delegates",
        drainsContinuationDelegateQueue: true,
        continuationChainState: {
          count: 7,
          startedAt: 1_783_520_000_000,
          tokens: 12_345,
          chainId: "chain-from-parent",
        },
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]).toMatchObject({
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      continuationChainCount: 7,
      continuationChainStartedAt: 1_783_520_000_000,
      continuationChainTokens: 12_345,
      continuationChainId: "chain-from-parent",
    });
  });

  it("forwards inherited traceparent to the child agent run", async () => {
    const { consumeSubagentTraceparentHandoff } =
      await import("../../subagent-traceparent-handoff.js");
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-traceparent", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    let persistedTraceparent: unknown;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedTraceparent ??= Object.values(store).find(
          (entry) => entry.continuationTraceparent,
        )?.continuationTraceparent;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "verify traceparent forwarding",
        traceparent,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.traceparent).toBe(traceparent);
    expect(
      consumeSubagentTraceparentHandoff({
        idempotencyKey: params.idempotencyKey as string,
        sessionKey: params.sessionKey as string,
      })?.traceparent,
    ).toBe(traceparent);
    expect(persistedTraceparent).toBe(traceparent);
    const registerInput = requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
    expect(registerInput.traceparent).toBe(traceparent);
  });
});
