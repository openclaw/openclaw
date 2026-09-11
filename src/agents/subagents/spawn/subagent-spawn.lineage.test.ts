import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { readInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../../gateway/server-methods/types.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import type { WorkerSessionTurnClaim } from "../../../gateway/worker-environments/placement-record.js";
import type {
  WorkerTurnExecutionIdentity,
  WorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { saveSubagentRegistryToSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { withParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
let stateDir = "";

function makeGatewayContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map(),
    clearChatRunState: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig,
  } as unknown as GatewayRequestContext;
}

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

describe("spawnSubagentDirect execution lineage", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      persistSubagentRunsToDiskOrThrow: saveSubagentRegistryToSqlite,
      restoreSubagentRunsFromDisk: () => 0,
    });

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
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    resetDetachedTaskLifecycleRuntimeForTests();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
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
      receiptAuthority: () => undefined,
      sessionKey: "agent:main:main",
      turnClaim,
    };
    let validations = 0;
    const capability: WorkerTurnExecutionIdentityCapability = {
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
});
