/** Admitted parent, worker, and registered spawn fixtures shared by recursive boundary proofs. */
import { vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { placementTurnOwner } from "../../../gateway/worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { writeSubagentSessionEntry } from "../registry/subagent-registry.persistence.test-support.js";

export function createSpawnOperatorSource() {
  const revocation = new AbortController();
  let requestOpen = true;
  let holds = 0;
  const assertCurrent = () => {
    revocation.signal.throwIfAborted();
    if (!requestOpen && holds === 0) {
      throw new Error("operator source has no live owner");
    }
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "spawn-operator",
    scopes: ["operator.read", "operator.write"],
    source: {},
    signal: revocation.signal,
    assertCurrent,
    retain: () => {
      assertCurrent();
      holds += 1;
      let held = true;
      return () => {
        if (held) {
          held = false;
          holds -= 1;
        }
      };
    },
  });
  return {
    authority,
    closeRequest: () => {
      requestOpen = false;
    },
    revoke: () => revocation.abort(new Error("operator source revoked")),
    get holds() {
      return holds;
    },
  };
}

export async function createSpawnBoundaryParent(params: {
  stateDir: string;
  parentSessionKey: string;
  parentRunId: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}) {
  const { stateDir, parentSessionKey, parentRunId, operatorAuthority } = params;
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
    operatorAuthority,
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
  return {
    cfg,
    storePath,
    context,
    admission,
    parent,
    admitted,
    gatewayBinding,
    execution,
    parentSessionKey,
    parentRunId,
  };
}

export async function createBoundWorker(
  bound: Awaited<ReturnType<typeof createSpawnBoundaryParent>>,
) {
  const { parentSessionKey, parentRunId } = bound;
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
  await bindWorkerTurnOwner(
    store,
    claim,
    bound.admitted.executionIdentityToken,
    bound.admission.operationalRunInstance,
    { ...session, storePath: bound.storePath },
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

export function createBoundSpawnInvocation(
  bound: Awaited<ReturnType<typeof createSpawnBoundaryParent>>,
  request?: { collect?: true; groupId?: string; context?: "isolated" | "fork" },
  requesterModel?: { provider: string; model: string },
) {
  const { parentSessionKey, parentRunId } = bound;
  const source = createSessionsSpawnTool({
    config: bound.cfg,
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
    requesterModel,
  });
  let tool = source;
  if (request?.collect) {
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
          tool.execute!("spawn-production-boundary", { task: "bounded child", ...request }),
        ),
    );
}
