import { expect, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import type { WorkerTunnelHandle, WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as fx from "./worker-turn-launcher.test-support.js";

export const localResult = async () => ({ meta: { durationMs: 1 } });

export const completedWorkerMessage = () =>
  makeAgentAssistantMessage({
    content: [{ type: "text", text: "Remote work completed" }],
    timestamp: 21,
  });

export function createLauncher(
  options: Partial<Parameters<typeof fx.createWorkerSessionTurnPlacementProvider>[0]> = {},
) {
  const { environments = fx.unusedEnvironments(), ...overrides } = options;
  return fx.createWorkerSessionTurnPlacementProvider({
    placements: fx.placements,
    environments,
    ...overrides,
  });
}

export function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function completeTurn(
  request: Parameters<WorkerTurnTunnelHandle["launchTurn"]>[0],
  text: string,
  timestamp: number,
) {
  const leaf = await fx.appendWorkerReply(text, timestamp);
  return fx.acknowledgeCompletedWorkerTurn(request.turnClaim, leaf);
}

export function launchDescriptor(plan: WorkerLaunchPlan) {
  return parseWorkerLaunchDescriptor({
    ...structuredClone(plan),
    connectionEndpoint: { kind: "unix", socketPath: "/worker/gateway.sock" },
  });
}

export async function revocableTurn(
  runId: string,
  authority: "source" | "admitted",
  boundary: string,
) {
  const base = fx.turn(runId);
  let sourceLive = true;
  const admission = prepareAgentRunAdmission({
    cfg: base.config,
    operationalRunInstance: createOperationalRunInstanceRef(base.runId),
    facts: {
      runId,
      agentId: fx.sessionTarget.agentId,
      ingress: { kind: "worker", boundary, state: "present" },
    },
    assertSourceCurrent: () => {
      if (!sourceLive) {
        throw new Error("source authority revoked");
      }
    },
  });
  const admitted = authority === "admitted" ? await admission.admit("embedded") : undefined;
  const close = () => admission.close();
  const revoke = admitted
    ? () => closeAdmittedRunDelegatedAuthority(admitted)
    : () => {
        sourceLive = false;
      };
  return {
    input: {
      ...base,
      preparedRunAdmission: admitted ? undefined : admission,
      admittedRunContext: admitted,
    },
    revoke,
    close,
    [Symbol.dispose]: close,
  };
}

export function runIdentity(runId: string) {
  const { sessionKey, agentId } = fx.sessionTarget;
  return { sessionId: fx.SESSION_ID, sessionKey, agentId, runId };
}

export function executeTurn(
  provider: ReturnType<typeof fx.createWorkerSessionTurnPlacementProvider>,
  runId: string,
  runLocal = localResult,
) {
  return provider.executeTurn(runIdentity(runId), fx.turn(runId), runLocal);
}

export function environmentForTunnel(
  overrides: Pick<fx.WorkerTurnEnvironmentService, "startTunnel"> &
    Partial<fx.WorkerTurnEnvironmentService>,
): fx.WorkerTurnEnvironmentService {
  return {
    get: vi.fn(fx.attachedEnvironment),
    acquireTurnCredential: vi.fn(async () => fx.credential()),
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    stopTunnel: vi.fn(async () => {}),
    destroy: vi.fn(async () => fx.attachedEnvironment()),
    ...overrides,
  };
}

export function remoteExecEnvironment(
  runWorkspaceCommand: WorkerTunnelHandle["runWorkspaceCommand"],
  onStart?: () => void,
) {
  const tunnel: WorkerTunnelHandle = {
    environmentId: fx.ENVIRONMENT_ID,
    ownerEpoch: fx.OWNER_EPOCH,
    runWorkspaceCommand,
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: fx.reconcileUnchangedLocalWorkspace,
    syncWorkspace: vi.fn(),
    stop: async () => {},
  };
  return {
    ...fx.unusedEnvironments(),
    get: vi.fn(fx.attachedEnvironment),
    startTunnel: vi.fn(async () => {
      onStart?.();
      return tunnel;
    }),
  };
}
