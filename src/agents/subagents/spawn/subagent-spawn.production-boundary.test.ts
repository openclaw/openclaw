/** Recursive spawn authority must survive the real Gateway and agent-command admission path. */
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  type OpenClawConfig,
} from "../../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { placementTurnOwner } from "../../../gateway/worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../../prepared-model-runtime.test-harness.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  enqueueSwarmRun,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { cleanupProvisionalSession } from "./subagent-spawn-cleanup.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";
import { registerNativeCancellationCases } from "./subagent-spawn.cancellation.test-support.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../embedded-agent.js", async () => {
  const { abortEmbeddedAgentRun, isEmbeddedAgentRunActive, waitForEmbeddedAgentRunEnd } =
    await import("../../embedded-agent-runner/runs.js");
  return {
    abortEmbeddedAgentRun,
    isEmbeddedAgentRunActive,
    runEmbeddedAgent,
    waitForEmbeddedAgentRunEnd,
  };
});

const parentSessionKey = "agent:main:subagent:production-boundary-parent";
const parentRunId = "production-boundary-parent";
// Two loaded exact-head CI runs reached this cold model boundary in 28–37 seconds.
const COLD_MODEL_ENTRY_TIMEOUT_MS = 60_000;
let state: OpenClawTestState;
let stateDir = "";
let runtimeConfig: OpenClawConfig;

async function writeTestConfig() {
  const config = {
    logging: { audit: { enabled: true, executionIdentity: true } },
    tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: stateDir,
        systemAgent: { agentId: "main" },
        model: { primary: "custom/test-model" },
      },
      entries: { main: { workspace: stateDir } },
    },
    models: {
      mode: "replace",
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "test-model",
              input: ["text"],
              maxTokens: 1_024,
              name: "Test model",
              reasoning: false,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  await state.writeConfig(config);
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  return config;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "spawn-production-boundary" });
  await resetPreparedModelRuntimeHarness(state);
  runEmbeddedAgent.mockReset();
  stateDir = state.stateDir;
  runtimeConfig = await writeTestConfig();
  const preparedRuntime = getPreparedModelRuntimeMocks();
  preparedRuntime.modelRegistry.fork.mockImplementation((authStorage) =>
    ModelRegistry.inMemory(authStorage),
  );
  const model = {
    api: "openai-completions" as const,
    baseUrl: "https://example.invalid/v1",
    contextWindow: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    id: "test-model",
    input: ["text" as const],
    maxTokens: 1_024,
    name: "Test model",
    provider: "custom",
    reasoning: false,
  };
  preparedRuntime.configuredAgentIds = ["main"];
  preparedRuntime.configuredAgentDirs.set("main", state.agentDir("main"));
  preparedRuntime.configuredWorkspaces.set("main", stateDir);
  preparedRuntime.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    runSubagentAnnounceFlow: async () => "delivered",
    callGateway: async <T>(request: CallGatewayOptions): Promise<T> => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return { status: "pending" } as T;
    },
  });
});

afterEach(async ({ task }) => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryControlRuntimeForTests();
  registryTesting.setDepsForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function createBoundParent() {
  const cfg = getRuntimeConfig();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const execution = new AsyncWorkScope();
  const context = createChatAbortContext({
    trackExecution: <T>(run: () => T | Promise<T>) => execution.track(run),
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-production-boundary-test", state: "present" },
    },
  });
  const parent = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: parentRunId,
    sessionKey: parentSessionKey,
    sessionId: "parent-session",
    agentId: "main",
    ownerConnId: "owner-connection",
    timeoutMs: 60_000,
    operationalRunInstance: admission.operationalRunInstance,
  });
  const admitted = await admission.admit("embedded");
  const gatewayBinding = { current: context as unknown as GatewayRequestContext };
  bindGatewayContextResolver(admitted, () => gatewayBinding.current);
  const authority = getAdmittedRunDelegatedAuthority(admitted)!;
  parent.bindAgentRunDelegatedAuthority(authority);
  return { cfg, storePath, context, admission, parent, admitted, gatewayBinding, execution };
}

function createBoundWorker(bound: Awaited<ReturnType<typeof createBoundParent>>) {
  const database = openOpenClawStateDatabase();
  const store = createWorkerSessionPlacementStore({ database });
  const session = { sessionId: "parent-session", agentId: "main", sessionKey: parentSessionKey };
  let placement = store.startDispatch({ ...session, executionMode: "worker-turn" });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: "queued-worker-environment" },
  });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/workspace/queued-worker",
    },
  });
  seedAttachedPlacementEnvironment(database, {
    environmentId: "queued-worker-environment",
    sessionId: session.sessionId,
    ownerEpoch: 1,
  });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: 1 },
  });
  if (placement.state !== "active") {
    throw new Error("expected the active worker placement");
  }
  const claim = store.claimTurn({
    ...session,
    owner: placementTurnOwner(placement),
    claimId: "queued-worker-claim",
    runId: parentRunId,
  });
  bindWorkerTurnOwner(
    store,
    claim,
    bound.admitted.executionIdentityToken,
    bound.admission.operationalRunInstance,
    session,
    () => {
      if (!getAdmittedRunDelegatedAuthority(bound.admitted)) {
        throw new Error("worker parent no longer active");
      }
    },
  );
  const capability = getWorkerTurnExecutionIdentityCapability(store, claim);
  if (!capability) {
    throw new Error("expected the admitted worker capability");
  }
  return { store, session, claim, capability };
}

function createBoundSpawnInvocation(
  bound: Awaited<ReturnType<typeof createBoundParent>>,
  collector?: { collect: true; groupId: string; context: "isolated" },
  requesterModel?: { provider: string; model: string },
) {
  const source = createSessionsSpawnTool({
    config: bound.cfg,
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
    requesterModel,
  });
  let tool = source;
  if (collector) {
    const [finalized] = finalizeAgentTools({
      tools: [
        source,
        createAgentsWaitTool({
          config: bound.cfg,
          agentSessionKey: parentSessionKey,
          agentId: "main",
        }),
      ],
      hookContext: {
        config: bound.cfg,
        agentId: "main",
        sessionKey: parentSessionKey,
        runId: parentRunId,
      },
      abortSignal: bound.parent.controller.signal,
    });
    if (!finalized) {
      throw new Error("expected the finalized spawn tool");
    }
    tool = finalized;
  }
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: bound.admitted,
    agentId: "main",
    sessionKey: parentSessionKey,
  });
  return () =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: bound.context as unknown as GatewayRequestContext,
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          tool.execute!("spawn-production-boundary", { task: "bounded child", ...collector }),
        ),
    );
}

async function createBoundGateway(bound: Awaited<ReturnType<typeof createBoundParent>>) {
  const [
    { readAgentRuntimeExecutionLineage },
    { createAgentRuntimeApprovalAuthorityValidator },
    { createGatewayInstanceRuntime },
    { createRequestGatewayMethodRegistry },
    { refreshPreparedModelRuntimeSnapshots },
  ] = await Promise.all([
    import("../../../gateway/agent-runtime-execution-lineage.js"),
    import("../../../gateway/agent-runtime-identity-token.js"),
    import("../../../gateway/server-instance-runtime.js"),
    import("../../../gateway/server-methods.js"),
    import("../../prepared-model-runtime.js"),
  ]);
  await refreshPreparedModelRuntimeSnapshots(bound.cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
    defaultWorkspaceDir: stateDir,
  });
  const context = bound.context as unknown as GatewayRequestContext;
  const validateRuntimeAuthority = createAgentRuntimeApprovalAuthorityValidator();
  const identities: AgentRuntimeIdentity[] = [];
  context.validateAgentRuntimeApprovalAuthority = (identity) => {
    identities.push(identity);
    return validateRuntimeAuthority(identity);
  };
  const methodRegistry = createRequestGatewayMethodRegistry();
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => methodRegistry,
    isDispatchAvailable: () => true,
  });
  context.createAgentTurnFacade = runtime.createAgentTurnFacade;
  context.getGatewayMethodRegistry = () => methodRegistry;
  return { context, runtime, identities, readAgentRuntimeExecutionLineage };
}

function readBoundExecutionState(
  bound: Awaited<ReturnType<typeof createBoundParent>>,
  childRunId?: string,
) {
  const context = bound.context as unknown as GatewayRequestContext;
  const receipt = childRunId ? context.dedupe.get(`agent:${childRunId}`) : undefined;
  const payload = asOptionalRecord(receipt?.payload);
  const cause = asOptionalRecord(asOptionalRecord(receipt?.error)?.cause);
  const controller = childRunId ? context.chatAbortControllers.get(childRunId) : undefined;
  const execution = childRunId ? subagentRuns.get(childRunId)?.execution : undefined;
  const label = (value: unknown, allowed: readonly string[]) =>
    typeof value === "string" && allowed.includes(value) ? value : "unknown";
  // Read bounded lifecycle facts before finally settles the synthetic model run.
  return {
    executionPending: bound.execution.hasPendingWork,
    receiptPresent: receipt !== undefined,
    receiptOk: receipt?.ok,
    receiptStatus: label(payload?.status, ["accepted", "in_flight", "ok", "error", "timeout"]),
    receiptErrorCode: label(receipt?.error?.code, ["UNAVAILABLE", "INVALID_REQUEST", "FORBIDDEN"]),
    causeName: label(cause?.name, [
      "Error",
      "TypeError",
      "AbortError",
      "TimeoutError",
      "SqliteWorkerError",
      "FailoverError",
    ]),
    controllerPresent: controller !== undefined,
    controllerAborted: controller?.controller.signal.aborted,
    executionStarted: controller?.executionStarted,
    executionStatus: label(execution?.status, ["queued", "running", "interrupted", "terminal"]),
    outcomeStatus: label(execution?.outcome?.status, ["ok", "error", "timeout"]),
    gatewayWarningCount: vi.mocked(context.logGateway.warn).mock.calls.length,
    runtimeWarningCount: getPreparedModelRuntimeMocks().warn.mock.calls.length,
  };
}

async function waitForEmbeddedRun(
  bound: Awaited<ReturnType<typeof createBoundParent>>,
  childRunId: string,
  started?: Promise<void>,
) {
  try {
    if (started) {
      await withTimeout(started, COLD_MODEL_ENTRY_TIMEOUT_MS, {
        message: "embedded execution entry timed out",
      });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledOnce(), {
        timeout: 15_000,
      });
    }
  } catch (cause) {
    // Only report owner facts; terminal messages can contain workspace paths or private input.
    throw new Error(
      `Embedded execution did not arrive: ${JSON.stringify(readBoundExecutionState(bound, childRunId))}`,
      { cause },
    );
  }
}

async function closeBoundGateway(
  bound: Awaited<ReturnType<typeof createBoundParent>>,
  runtime: Awaited<ReturnType<typeof createBoundGateway>>["runtime"],
  childRunId?: string,
  releaseQueuedAuthority?: () => void,
) {
  const failures: unknown[] = [];
  try {
    bound.execution.beginClose();
    await vi.waitFor(
      () => {
        expect(bound.execution.hasPendingWork).toBe(false);
        if (childRunId) {
          expect(bound.context.chatAbortControllers.has(childRunId)).toBe(false);
        }
        // Fence new work in the same turn that observes idle; never start an unbounded drain.
        return bound.execution.drain();
      },
      { timeout: 15_000 },
    );
  } catch (cause) {
    failures.push(
      new Error(
        `Gateway fixture cleanup failed: ${JSON.stringify(readBoundExecutionState(bound, childRunId))}`,
        { cause },
      ),
    );
  }
  for (const close of [
    () => runtime.close(),
    ...(releaseQueuedAuthority ? [releaseQueuedAuthority] : []),
    () => bound.admission.close(),
    () => bound.parent.cleanup(),
  ]) {
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function throwBoundFailures(failures: unknown[]) {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Spawn proof and fixture cleanup failed", {
      cause: failures[0],
    });
  }
}

describe("recursive spawn production boundary", () => {
  registerNativeCancellationCases({
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    parentSessionKey,
    parentRunId,
    assertNoModelExecution: () => expect(runEmbeddedAgent).not.toHaveBeenCalled(),
  });

  it.each([
    {
      name: "configured child model",
      configuredChildModel: true,
      storedParentModel: "test-model",
      requesterModel: { provider: "custom", model: "test-model" },
    },
    { name: "parent session model", configuredChildModel: false, storedParentModel: "child-model" },
    {
      name: "active parent turn model",
      configuredChildModel: false,
      storedParentModel: "test-model",
      requesterModel: { provider: "custom", model: "child-model" },
    },
  ])("admits a descendant using the $name", async (scenario) => {
    const { configuredChildModel, storedParentModel, requesterModel } = scenario;
    const customProvider = expectDefined(
      runtimeConfig.models?.providers?.custom,
      "custom provider fixture",
    );
    const primaryModel = expectDefined(customProvider.models[0], "primary model fixture");
    const childModel = { ...primaryModel, id: "child-model", name: "Child model" };
    runtimeConfig = {
      ...runtimeConfig,
      agents: {
        ...runtimeConfig.agents,
        defaults: {
          ...runtimeConfig.agents?.defaults,
          ...(configuredChildModel ? { subagents: { model: "custom/child-model" } } : {}),
          modelPolicy: { allow: ["custom/manual-only"] },
        },
      },
      models: {
        ...runtimeConfig.models,
        providers: {
          ...runtimeConfig.models?.providers,
          custom: { ...customProvider, models: [primaryModel, childModel] },
        },
      },
    };
    const catalog = [primaryModel, childModel].map((model) =>
      Object.assign({}, model, {
        provider: "custom",
        api: "openai-completions" as const,
        baseUrl: customProvider.baseUrl,
        contextWindow: 4_096,
      }),
    );
    getPreparedModelRuntimeMocks().buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: catalog,
      routeVariants: catalog,
    });
    await state.writeConfig(runtimeConfig);
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const bound = await createBoundParent();
    await upsertSessionEntryCore(
      { storePath: bound.storePath, sessionKey: parentSessionKey },
      {
        providerOverride: "custom",
        modelOverride: storedParentModel,
        modelOverrideSource: "user",
      },
    );
    const { context, runtime, identities, readAgentRuntimeExecutionLineage } =
      await createBoundGateway(bound);
    const modelRun = createDeferred<EmbeddedAgentRunResult>();
    const modelRunStarted = createDeferred();
    runEmbeddedAgent.mockImplementationOnce(() => {
      modelRunStarted.resolve();
      return modelRun.promise;
    });
    let childRunId: string | undefined;
    const failures: unknown[] = [];
    try {
      const result = await createBoundSpawnInvocation(bound, undefined, requesterModel)();
      expect(result.details, JSON.stringify(result)).toMatchObject({
        status: "accepted",
        childSessionKey: expect.any(String),
        runId: expect.any(String),
      });
      const details = result.details as { childSessionKey: string; runId: string };
      childRunId = details.runId;
      await waitForEmbeddedRun(bound, details.runId, modelRunStarted.promise);
      const embeddedRun = runEmbeddedAgent.mock.calls[0]?.[0];
      expect(embeddedRun).toMatchObject({
        runId: details.runId,
        sessionKey: details.childSessionKey,
        provider: "custom",
        model: "child-model",
      });
      expect(context.chatAbortControllers.get(details.runId)).toMatchObject({
        agentId: "main",
        sessionKey: details.childSessionKey,
        operationalRunInstance: { runId: details.runId },
      });
      const observedRuntimeIdentity = identities.at(-1);
      expect(observedRuntimeIdentity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: parentSessionKey,
      });
      expect(
        readAgentRuntimeExecutionLineage(observedRuntimeIdentity?.sessionSpawnContext),
      ).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: parentSessionKey,
        controllerRef: parentSessionKey,
        depth: 2,
        applicableGrantRefs: ["tool:sessions_spawn"],
        runtimeAssuranceRefs: ["spawn-runtime:subagent"],
      });
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey }),
      ).toMatchObject({
        spawnedBy: parentSessionKey,
        spawnDepth: 2,
        providerOverride: "custom",
        modelOverride: "child-model",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "custom",
        modelOverrideFallbackOriginModel: "child-model",
      });
      expect(subagentRuns.get(details.runId)).toMatchObject({
        childSessionKey: details.childSessionKey,
        requesterSessionKey: parentSessionKey,
      });
    } catch (error) {
      failures.push(error);
    } finally {
      modelRun.resolve({
        payloads: [{ text: "descendant complete" }],
        meta: { durationMs: 1 },
      });
      failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
      throwBoundFailures(failures);
    }
  });

  it.each(["active", "completed", "stopped"] as const)(
    "keeps queued collector effects with their original parent when it is %s",
    async (parentState) => {
      const bound = await createBoundParent();
      const { context, runtime, identities } = await createBoundGateway(bound);
      const groupId = "production-boundary-queued";
      const capacityStarted = createDeferred();
      enqueueSwarmRun({
        groupId: JSON.stringify(["main", parentSessionKey, groupId]),
        runId: "production-boundary-capacity",
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          capacityStarted.resolve();
        },
        onStartFailure: () => true,
      });
      await capacityStarted.promise;
      const releaserInstance = createOperationalRunInstanceRef("capacity-releasing-run");
      const releaserAuthority = claimAgentRunDelegatedAuthority(releaserInstance);
      const modelRun = createDeferred<EmbeddedAgentRunResult>();
      runEmbeddedAgent.mockReturnValueOnce(modelRun.promise);
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      const abortParent = () =>
        withPluginRuntimeGatewayRequestScope(
          {
            context,
            client: {
              ...createSyntheticPluginRuntimeClient({
                scopes: ["operator.read", "operator.write"],
              }),
              connId: "owner-connection",
            },
            isWebchatConnect: () => false,
          },
          () =>
            dispatchGatewayMethodInProcess(
              "chat.abort",
              { sessionKey: parentSessionKey, runId: parentRunId },
              { resolveGatewayContext: () => context },
            ),
        );
      try {
        const result = await createBoundSpawnInvocation(bound, {
          collect: true,
          groupId,
          context: "isolated",
        })();
        expect(result.details, JSON.stringify(result)).toMatchObject({
          status: "accepted",
          runId: expect.any(String),
          childSessionKey: expect.any(String),
        });
        const details = result.details as { runId: string; childSessionKey: string };
        childRunId = details.runId;
        expect(subagentRuns.get(childRunId)).toMatchObject({
          requesterTurnRunId: parentRunId,
          execution: { status: "queued" },
        });
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        if (parentState === "completed") {
          bound.admission.close();
          bound.parent.cleanup();
          expect(bound.parent.controller.signal.aborted).toBe(false);
          expect(getAdmittedRunDelegatedAuthority(bound.admitted)).toBeUndefined();
        } else if (parentState === "stopped") {
          await expect(abortParent()).resolves.toMatchObject({
            aborted: true,
            runIds: [parentRunId],
          });
          expect(findTaskByRunId(childRunId)?.status).toBe("cancelled");
        }
        identities.length = 0;
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:subagent:capacity-releaser",
            operationalRunInstance: releaserInstance,
            gatewayContextResolver: () => context,
          },
          () => releaseSwarmRun("production-boundary-capacity"),
        );
        if (parentState === "stopped") {
          await Promise.resolve();
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          expect(context.chatAbortControllers.has(childRunId)).toBe(false);
          expect(subagentRuns.get(childRunId)).toMatchObject({
            collectorCompletion: { status: "killed" },
          });
        } else {
          await waitForEmbeddedRun(bound, childRunId);
          expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
            runId: childRunId,
            sessionKey: details.childSessionKey,
          });
          expect(context.chatAbortControllers.get(childRunId)).toMatchObject({
            sessionKey: details.childSessionKey,
            operationalRunInstance: { runId: childRunId },
          });
          expect(subagentRuns.get(childRunId)).toMatchObject({
            requesterSessionKey: parentSessionKey,
            execution: { status: "running" },
          });
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey }),
          ).toMatchObject({ spawnedBy: parentSessionKey, spawnDepth: 2 });
          expect(
            identities.some((identity) => identity.operationalRunInstance === releaserInstance),
          ).toBe(false);
          if (parentState === "active") {
            expect(
              identities.some(
                (identity) =>
                  identity.operationalRunInstance === bound.admission.operationalRunInstance,
              ),
            ).toBe(true);
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (childRunId && subagentRuns.get(childRunId)?.execution.status === "queued") {
            await abortParent();
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          releaseSwarmRun("production-boundary-capacity");
        } catch (error) {
          failures.push(error);
        }
        modelRun.resolve({ payloads: [{ text: "collector complete" }], meta: { durationMs: 1 } });
        failures.push(
          ...(await closeBoundGateway(bound, runtime, childRunId, () =>
            releaseAgentRunDelegatedAuthority(releaserAuthority),
          )),
        );
        throwBoundFailures(failures);
      }
    },
  );

  it.each([
    "current",
    "replaced-session",
    "replaced-gateway",
    "worker-current",
    "worker-reassigned",
    "worker-reassigned-during-delete",
  ] as const)("fences queued cleanup at the real session deletion boundary: %s", async (target) => {
    const bound = await createBoundParent();
    const { context, runtime } = await createBoundGateway(bound);
    const childSessionKey = "agent:main:subagent:queued-cleanup";
    const original = {
      sessionId: "queued-cleanup-session",
      lifecycleRevision: "queued-cleanup-generation",
      updatedAt: 1,
      label: "original",
    };
    await upsertSessionEntryCore(
      { storePath: bound.storePath, sessionKey: childSessionKey },
      original,
    );
    let expectedEntry = loadSessionEntry({
      storePath: bound.storePath,
      sessionKey: childSessionKey,
    });
    const worker = target.startsWith("worker-") ? createBoundWorker(bound) : undefined;
    let replacementClaim: ReturnType<NonNullable<typeof worker>["store"]["claimTurn"]> | undefined;
    const results: boolean[] = [];
    const errors: unknown[] = [];
    const failures: unknown[] = [];
    const interrupted = createDeferred();
    let work: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: bound.admitted,
      agentId: "main",
      sessionKey: parentSessionKey,
    });
    if (!caller) {
      throw new Error("expected the admitted cleanup caller");
    }
    reserveSwarmRun({
      groupId: "queued-cleanup",
      runId: "queued-cleanup",
      maxConcurrent: 1,
      activeRunIds: ["cleanup-capacity"],
    });
    const activate = (identity: typeof caller) =>
      withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        withGatewayToolCallerIdentity(identity, () =>
          activateSwarmRun({
            groupId: "queued-cleanup",
            runId: "queued-cleanup",
            start: async () => {},
            onStartFailure: () => true,
            onRemoved: async () => {
              results.push(
                await cleanupProvisionalSession(childSessionKey, {
                  expectedSessionId: original.sessionId,
                  expectedLifecycleRevision: original.lifecycleRevision,
                  callGateway: async (request) => {
                    try {
                      return await callSubagentGateway(request);
                    } catch (error) {
                      errors.push(error);
                      throw error;
                    }
                  },
                }),
              );
            },
          }),
        ),
      );
    try {
      if (target === "worker-reassigned-during-delete") {
        work = await beginSessionWorkAdmission({
          scope: bound.storePath,
          identities: [childSessionKey, original.sessionId],
          assertAllowed: () => {},
          onInterrupt: () => interrupted.resolve(),
        });
      }
      if (worker) {
        expect(bound.admitted.executionIdentityToken).toBeDefined();
        await worker.capability.run((identity) =>
          activate({
            ...caller,
            workerTurnClaim: identity.turnClaim,
            workerTurnExecutionIdentityCapability: worker.capability,
            executionIdentityToken: identity.executionIdentityToken,
          }),
        );
      } else {
        await activate(caller);
      }
      if (target === "replaced-session") {
        await upsertSessionEntryCore(
          { storePath: bound.storePath, sessionKey: childSessionKey },
          {
            ...original,
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-generation",
            label: "replacement",
          },
        );
        expectedEntry = loadSessionEntry({
          storePath: bound.storePath,
          sessionKey: childSessionKey,
        });
      } else if (target === "replaced-gateway") {
        bound.gatewayBinding.current = { ...context };
      } else if (target === "worker-reassigned" && worker) {
        worker.store.releaseTurn(worker.claim);
        replacementClaim = worker.store.claimTurn({
          ...worker.session,
          owner: worker.claim.owner,
          claimId: "replacement-claim",
          runId: "replacement-run",
        });
      }
      const removal = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:subagent:cleanup-remover",
          gatewayContextResolver: () => context,
        },
        async () => {
          const hold = holdQueuedSwarmRun("queued-cleanup");
          if (!hold) {
            throw new Error("expected the queued cleanup reservation");
          }
          expect(hold.withdraw()).toBe(true);
          await hold.release();
        },
      );
      if (target === "worker-reassigned-during-delete" && worker) {
        await Promise.race([
          interrupted.promise,
          removal.then(() => {
            throw new Error("cleanup ended before the session mutation barrier");
          }),
        ]);
        worker.store.releaseTurn(worker.claim);
        replacementClaim = worker.store.claimTurn({
          ...worker.session,
          owner: worker.claim.owner,
          claimId: "replacement-claim",
          runId: "replacement-run",
        });
        work?.release();
      }
      await removal;
      const deleted = target === "current" || target === "worker-current";
      expect(results, errors.map(String).join("\n")).toEqual([deleted]);
      if (deleted) {
        expect(errors).toEqual([]);
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: childSessionKey }),
        ).toBeUndefined();
      } else {
        expect(errors).toHaveLength(1);
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: childSessionKey }),
        ).toEqual(expectedEntry);
      }
      if (replacementClaim && worker) {
        expect(worker.store.validateTurnClaim(replacementClaim)).toBe(true);
      }
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        work?.release();
      } catch (error) {
        failures.push(error);
      }
      bound.gatewayBinding.current = context;
      try {
        await closeSwarmScheduler();
      } catch (error) {
        failures.push(error);
      }
      try {
        releaseSwarmRun("cleanup-capacity");
      } catch (error) {
        failures.push(error);
      }
      try {
        if (worker && worker.store.validateTurnClaim(replacementClaim ?? worker.claim)) {
          worker.store.releaseTurn(replacementClaim ?? worker.claim);
        }
      } catch (error) {
        failures.push(error);
      }
      failures.push(...(await closeBoundGateway(bound, runtime)));
      throwBoundFailures(failures);
    }
  });
});
