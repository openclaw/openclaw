import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { readInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestOptions } from "../../../gateway/server-methods/types.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import type { WorkerSessionTurnClaim } from "../../../gateway/worker-environments/placement-record.js";
import type {
  WorkerTurnExecutionIdentity,
  WorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  configureMockSubagentRegistryPersistence,
  type MockSubagentRegistryRows,
} from "../../subagent-test-fixtures.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { markSubagentRunTerminated } from "../registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { withParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { buildSubagentExecutionSessionSpawnContext } from "./subagent-spawn-execution-identity.js";
import "./subagent-spawn-model.mocks.shared.js";
import { makeGatewayContext } from "./subagent-spawn.in-process-gateway.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));
vi.mock("../registry/subagent-registry-state.js", { spy: true });
vi.mock("../registry/subagent-registry-persistence.js", { spy: true });

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
let stateDir = "";
const persistRegistryRows = vi.fn<MockSubagentRegistryRows>();

function externalCliClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
      scopes: ["operator.write"],
    },
  } as GatewayRequestOptions["client"];
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 10) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw lastError;
}

describe("spawnSubagentDirect in-process Gateway collector launch", () => {
  it("does not construct private lineage while identity collection is disabled", () => {
    expect(
      buildSubagentExecutionSessionSpawnContext({
        enabled: false,
        backend: "subagent",
        parentAgentId: "main",
        requesterRef: "agent:main:main",
        controllerRef: "agent:main:main",
        depth: 1,
        targetAgentId: "main",
        sandbox: "inherit",
      }),
    ).toBeUndefined();
  });

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    await resetSubagentRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
    persistRegistryRows.mockReset();
    await configureMockSubagentRegistryPersistence({ persistRegistryRows });
    vi.mocked(restoreSubagentRunsFromDisk).mockResolvedValue(0);

    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-gateway-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        logging: { audit: { enabled: true, executionIdentity: true } },
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: {
          defaults: { workspace: stateDir },
          entries: { main: { workspace: stateDir } },
        },
      })}\n`,
    );
    clearConfigCache();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    persistRegistryRows.mockReset();
    vi.mocked(restoreSubagentRunsFromDisk).mockReset();
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("launches queued collectors after the parent admission lease is released", async ({
    signal,
  }) => {
    const gatewayContext = makeGatewayContext();
    const firstLaunchGate = createDeferredCore();
    const dispatches = [createDeferredCore(), createDeferredCore()];
    const waitEntries = [createDeferredCore(), createDeferredCore()];
    const terminalReplies = [createDeferredCore(), createDeferredCore()];
    const launchedRunIds: string[] = [];
    const subordinateAdmissionStates: boolean[] = [];
    let launchCount = 0;
    gatewayContext.recoveryRuntime = {
      waitForAgent: async <T>(params: { runId: string }): Promise<T> => {
        const index = launchedRunIds.indexOf(params.runId);
        const terminal = expectDefined(terminalReplies[index], "launched collector terminal owner");
        const startedAt = Date.now();
        expectDefined(waitEntries[index], "launched collector wait owner").resolve();
        await terminal.promise;
        return {
          status: "ok",
          startedAt,
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "collector finished" },
        } as T;
      },
      dispatchAgent: async () => {
        throw new Error("Unexpected fixture recovery agent dispatch");
      },
      dispatchSessionMethod: async (method) => {
        throw new Error(`Unexpected fixture recovery session method ${method}`);
      },
      sendRecoveryNotice: async () => {
        throw new Error("Unexpected fixture recovery notice");
      },
    } satisfies GatewayRecoveryRuntime;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        expect(method).toBe("agent");
        subordinateAdmissionStates.push(isGatewaySubordinateWorkAdmissionClosed());
        launchedRunIds.push(String(params.idempotencyKey));
        launchCount += 1;
        expectDefined(dispatches[launchCount - 1], "expected collector dispatch").resolve();
        if (launchCount === 1) {
          await firstLaunchGate.promise;
        }
        return {
          runId: params.idempotencyKey as string,
          status: "accepted",
        } as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    const settleRootWork = observeRootWork();
    const terminalPublications = new Map<string, ReturnType<typeof createDeferredCore<void>>>();
    const stopObserving = subscribeSubagentRunChanges("projection", () => {
      for (const [runId, terminal] of terminalPublications) {
        if (subagentRuns.get(runId)?.execution.status === "terminal") {
          terminal.resolve();
        }
      }
    });
    let spawnedWork: ReturnType<typeof spawnSubagentDirect>[] = [];
    let spawning: Promise<Awaited<ReturnType<typeof spawnSubagentDirect>>[]> | undefined;
    try {
      expect(parentAdmission).not.toBeNull();
      spawning = parentAdmission!.run(() =>
        withPluginRuntimeGatewayRequestScope(
          {
            context: gatewayContext,
            client: externalCliClient(),
            isWebchatConnect: () => false,
          },
          () => {
            spawnedWork = [
              spawnSubagentDirect(
                {
                  task: "first collector",
                  collect: true,
                  context: "isolated",
                  lightContext: true,
                  groupId: "swarm-queued-launch",
                  swarmLaunchReplayKey: "code-mode:agentSpawn:1",
                },
                {
                  agentSessionKey: "agent:main:main",
                  requesterRunId: "parent-run",
                },
              ),
              spawnSubagentDirect(
                {
                  task: "second collector",
                  collect: true,
                  context: "isolated",
                  lightContext: true,
                  groupId: "swarm-queued-launch",
                  swarmLaunchReplayKey: "code-mode:agentSpawn:2",
                },
                {
                  agentSessionKey: "agent:main:main",
                  requesterRunId: "parent-run",
                },
              ),
            ];
            return Promise.all(spawnedWork);
          },
        ),
      );
      const results = await withinTest(spawning, signal);
      parentAdmission!.release();

      expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
      await withinTest(dispatches[0]!.promise, signal);
      expect(launchCount).toBe(1);
      firstLaunchGate.resolve();
      await withinTest(waitEntries[0]!.promise, signal);
      expect(launchCount).toBe(1);
      const queued = expectDefined(
        results.find((result) => result.runId !== launchedRunIds[0]),
        "queued collector",
      );
      expect(subagentRuns.get(queued.runId!)).toMatchObject({
        execution: { status: "queued" },
        swarmLaunchPending: true,
      });
      terminalReplies[0]!.resolve();
      await withinTest(Promise.all([dispatches[1]!.promise, waitEntries[1]!.promise]), signal);
      expect(launchCount).toBe(2);
      expect(subagentRuns.get(launchedRunIds[0]!)).toMatchObject({
        execution: { status: "terminal", outcome: { status: "ok" } },
      });
      for (const result of results) {
        expect(subagentRuns.get(result.runId!)).toMatchObject({
          collect: true,
          swarmLaunchPending: false,
        });
      }
      expect(subordinateAdmissionStates).toEqual([false, false]);
    } finally {
      firstLaunchGate.resolve();
      terminalReplies.forEach((reply) => reply.resolve());
      parentAdmission?.release();
      try {
        await Promise.allSettled(spawnedWork);
        const results = await spawning;
        await withinTest(
          Promise.all(
            (results ?? []).flatMap((result) => {
              if (result.status !== "accepted" || !result.runId) {
                return [];
              }
              if (subagentRuns.get(result.runId)?.execution.status === "terminal") {
                return [];
              }
              const terminal = createDeferredCore();
              terminalPublications.set(result.runId, terminal);
              return [terminal.promise];
            }),
          ),
          signal,
        );
      } finally {
        try {
          await settleRootWork();
        } finally {
          stopObserving();
        }
      }
    }
  });

  it("gives each selected global agent its own collector capacity", async () => {
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        session: { scope: "global" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: {
          ownership: "explicit",
          defaults: { workspace: stateDir },
          entries: {
            main: { workspace: stateDir },
            worker: { workspace: stateDir },
          },
        },
      }),
    );
    clearConfigCache();
    const launched: string[] = [];
    const launchGate = createDeferredCore();
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method === "agent") {
          launched.push(params.sessionKey as string);
          await launchGate.promise;
        }
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const results = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        Promise.all(
          ["main", "worker"].map((requesterAgentIdOverride) =>
            spawnSubagentDirect(
              {
                task: "collect independently",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "shared",
              },
              {
                agentSessionKey: "global",
                requesterAgentIdOverride,
                requesterRunId: `parent-${requesterAgentIdOverride}`,
              },
            ),
          ),
        ),
    );
    try {
      expect(results).toMatchObject([{ status: "accepted" }, { status: "accepted" }]);
      await waitForAssertion(() =>
        expect(launched.toSorted()).toEqual(
          results
            .map((result) => expectDefined(result.childSessionKey, "accepted child session key"))
            .toSorted(),
        ),
      );
    } finally {
      launchGate.resolve();
      await waitForAssertion(() =>
        expect(subagentRuns.get(results[0]!.runId!)?.swarmLaunchPending).toBe(false),
      );
    }
  });

  it("consumes the exact private parent token in the child Gateway identity", async () => {
    const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    let childIdentity: AgentRuntimeIdentity | undefined;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });

    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: makeGatewayContext(),
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:main",
              operationalRunInstance,
              executionIdentityToken: parentToken,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
            },
            () =>
              spawnSubagentDirect(
                { task: "inspect lineage", context: "isolated", lightContext: true },
                withParentExecutionIdentity({ agentSessionKey: "agent:main:main" }, parentToken),
              ),
          ),
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("accepted");
      expect(childIdentity?.executionIdentity).toBe(parentToken);
      expect(readAgentRuntimeExecutionLineage(childIdentity?.sessionSpawnContext)).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: "agent:main:main",
        controllerRef: "agent:main:main",
        depth: 1,
        applicableGrantRefs: ["tool:sessions_spawn"],
        externalNativeActions: "observable",
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("revalidates the worker capability at the child Gateway admission boundary", async () => {
    const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = {
      sessionId: "parent-session-id",
      runId: "parent-run",
      claimId: "parent-claim",
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: "worker-env", ownerEpoch: 7 },
    } satisfies WorkerSessionTurnClaim;
    const identity: WorkerTurnExecutionIdentity = {
      agentId: "main",
      delegatedAuthority: authority,
      executionIdentityToken: parentToken,
      operationalRunInstance,
      receiptAuthority: () => {
        if (!validateAgentRunDelegatedAuthority(authority)) {
          throw new Error("worker execution authority is no longer active");
        }
      },
      sessionKey: "agent:main:main",
      sessionTarget: {
        agentId: "main",
        sessionId: turnClaim.sessionId,
        sessionKey: "agent:main:main",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      },
      turnClaim,
    };
    let validations = 0;
    const capability: WorkerTurnExecutionIdentityCapability = {
      sessionTarget: identity.sessionTarget,
      receiptAuthority: identity.receiptAuthority,
      async run<T>(callback: (current: WorkerTurnExecutionIdentity) => Promise<T> | T) {
        validations += 1;
        return await callback(identity);
      },
    };
    let childIdentity: AgentRuntimeIdentity | undefined;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });

    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: makeGatewayContext(),
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          capability.run((current) =>
            withGatewayToolCallerIdentity(
              {
                agentId: current.agentId,
                sessionKey: current.sessionKey,
                operationalRunInstance: current.operationalRunInstance,
                executionIdentityToken: current.executionIdentityToken,
                receiptAuthority: current.receiptAuthority,
                workerTurnClaim: current.turnClaim,
                workerTurnExecutionIdentityCapability: capability,
              },
              () =>
                spawnSubagentDirect(
                  { task: "inspect worker lineage", context: "isolated", lightContext: true },
                  withParentExecutionIdentity(
                    { agentSessionKey: current.sessionKey },
                    current.executionIdentityToken,
                  ),
                ),
            ),
          ),
      );

      expect(result.status).toBe("accepted");
      expect(validations).toBe(2);
      expect(childIdentity?.delegatedAuthority).toMatchObject({
        kind: "worker",
        turnClaim,
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("aborts a collector cancelled while Gateway acceptance is in flight", async () => {
    const gatewayContext = makeGatewayContext();
    const firstLaunchGate = createDeferredCore();
    const firstDispatch = createDeferredCore();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let launchCount = 0;
    const transport = vi.fn(async () => {
      throw new Error("Hosted collector cleanup must not open a Gateway transport");
    });
    subagentSpawnTesting.setDepsForTest({
      callGateway: transport,
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          const launchOrdinal = ++launchCount;
          if (launchOrdinal === 1) {
            firstDispatch.resolve();
            await firstLaunchGate.promise;
          }
          return { runId: `gateway-run-${launchOrdinal}`, status: "accepted" } as T;
        }
        return {} as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    expect(parentAdmission).not.toBeNull();
    const results = await parentAdmission!.run(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          context: gatewayContext,
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          Promise.all([
            // Arrival order may differ from Promise.all result order.
            firstDispatch.promise.then(() =>
              spawnSubagentDirect(
                {
                  task: "queued collector",
                  collect: true,
                  context: "isolated",
                  lightContext: true,
                  groupId: "swarm-cancel-launch",
                  swarmLaunchReplayKey: "code-mode:agentSpawn:cancelled",
                },
                { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
              ),
            ),
            spawnSubagentDirect(
              {
                task: "in-flight collector",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "swarm-cancel-launch",
                swarmLaunchReplayKey: "code-mode:agentSpawn:next",
              },
              { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
            ),
          ]),
      ),
    );
    parentAdmission!.release();
    await waitForAssertion(() => expect(launchCount).toBe(1));
    const firstRequest = expectDefined(
      requests.find((request) => request.method === "agent"),
      "in-flight Gateway request",
    );
    const firstRunId = expectDefined(
      results.find((result) => result.runId === firstRequest.params.idempotencyKey)?.runId,
      "accepted in-flight collector",
    );
    const nextRunId = expectDefined(
      results.find((result) => result.runId !== firstRunId)?.runId,
      "queued collector",
    );

    expect(await markSubagentRunTerminated({ runId: firstRunId, reason: "manual kill" })).toBe(1);
    const killedEntry = expectDefined(subagentRuns.get(firstRunId!), "killed collector");
    const killedSnapshot = structuredClone(killedEntry);
    const killedExecution = structuredClone(killedEntry.execution);
    const killedReconciliation = structuredClone(killedEntry.killReconciliation);
    expect(killedSnapshot).toMatchObject({
      endedReason: "subagent-killed",
      execution: {
        status: "terminal",
        endedAt: expect.any(Number),
        outcome: { status: "error", error: "manual kill" },
      },
    });
    firstLaunchGate.resolve();

    await waitForAssertion(() => {
      expect(
        requests.some(
          (request) => request.method === "chat.abort" && request.params.runId === "gateway-run-1",
        ),
      ).toBe(true);
      expect(launchCount).toBe(2);
      expect(subagentRuns.get(firstRunId!)?.collectorCompletion).toMatchObject({
        status: "killed",
      });
      expect(subagentRuns.get(firstRunId!)?.swarmLaunchPending).toBe(false);
      expect(subagentRuns.get(firstRunId!)?.queuedLaunch).toBeUndefined();
      expect(subagentRuns.get(firstRunId!)?.execution).toEqual(killedExecution);
      expect(subagentRuns.get(firstRunId!)?.killReconciliation).toEqual(killedReconciliation);
      expect(subagentRuns.get(firstRunId!)).toEqual({
        ...killedSnapshot,
        swarmLaunchPending: false,
        queuedLaunch: undefined,
        collectorLaunchCleanupPending: false,
        completion: {
          required: false,
          resultText: "manual kill",
          capturedAt: killedExecution.endedAt,
        },
        collectorCompletion: { status: "killed" },
        structuredOutput: undefined,
        archiveAtMs: expectDefined(killedExecution.endedAt, "killed run end") + 60 * 60_000,
        cleanupCompletedAt: expect.any(Number),
        contextEngineCleanupCompletedAt: expect.any(Number),
      });
      const settledEntry = expectDefined(subagentRuns.get(firstRunId!), "settled collector");
      expect(settledEntry.cleanupCompletedAt).toBe(settledEntry.contextEngineCleanupCompletedAt);
      expect(settledEntry.cleanupCompletedAt).toBeGreaterThanOrEqual(killedExecution.endedAt!);
      expect(subagentRuns.get("gateway-run-2")).toMatchObject({
        swarmRunId: nextRunId,
        swarmLaunchPending: false,
      });
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts the accepted child run when registry registration fails", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let acceptedChildSessionKey: unknown;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          acceptedChildSessionKey = params.sessionKey;
          return { runId: "gateway-accepted-run", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          if (
            params.sessionKey !== acceptedChildSessionKey ||
            params.runId !== "gateway-accepted-run"
          ) {
            throw new Error("Abort must target the accepted child session and run");
          }
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });
    // The registry never takes ownership, which is exactly when the suppressed
    // gateway CLI row would have been the only record of the accepted run.
    persistRegistryRows.mockImplementation(() => {
      throw new Error("state db unavailable");
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          { task: "orphan me", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Failed to register subagent run");
    expect(result.childSessionKey).toEqual(expect.any(String));
    // No registry row exists, so an unaborted run would execute with no task row at all.
    expect(requests).toContainEqual({
      method: "chat.abort",
      params: { sessionKey: result.childSessionKey, runId: "gateway-accepted-run" },
    });
  });

  it("does not abort an out-of-process run when registry persistence fails", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => false,
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        requests.push({
          method: request.method,
          params: (request.params ?? {}) as Record<string, unknown>,
        });
        return {
          runId: request.method === "agent" ? "gateway-owned-unregistered-run" : undefined,
          status: "accepted",
        } as T;
      },
    });
    persistRegistryRows.mockImplementation(() => {
      throw new Error("state db unavailable");
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          { task: "keep remote ownership", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Failed to register subagent run");
    expect(requests.some((request) => request.method === "chat.abort")).toBe(false);
  });
});
