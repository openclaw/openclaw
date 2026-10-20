import { expect, vi } from "vitest";
import * as runAuthority from "../../agents/admitted-run-context.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import * as launch from "../../worker/launch-descriptor.js";
import type { WorkerTunnelHandle, WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as fx from "./worker-turn-launcher.test-support.js";

const createProvider = fx.createWorkerSessionTurnPlacementProvider;
type Environments = fx.WorkerTurnEnvironmentService;
type LaunchRequest = Parameters<WorkerTurnTunnelHandle["launchTurn"]>[0];
export const localResult = async () => ({ meta: { durationMs: 1 } });

export const completedWorkerMessage = () =>
  makeAgentAssistantMessage({
    content: [{ type: "text", text: "Remote work completed" }],
    timestamp: 21,
  });

export function createLauncher(options: Partial<Parameters<typeof createProvider>[0]> = {}) {
  const { environments = fx.unusedEnvironments(), ...overrides } = options;
  return createProvider({ placements: fx.placements, environments, ...overrides });
}

export function expectUncalled(...mocks: unknown[]) {
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
}

export async function completeTurn(request: LaunchRequest, text: string, timestamp: number) {
  const leaf = await fx.appendWorkerReply(text, timestamp);
  return fx.acknowledgeCompletedWorkerTurn(request.turnClaim, leaf);
}

export function launchDescriptor(plan: launch.WorkerLaunchPlan) {
  return launch.parseWorkerLaunchDescriptor({
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
  const source = new AbortController();
  const admission = runAuthority.prepareAgentRunAdmission({
    cfg: base.config,
    operationalRunInstance: runAuthority.createOperationalRunInstanceRef(base.runId),
    facts: {
      runId,
      agentId: fx.sessionTarget.agentId,
      ingress: { kind: "worker", boundary, state: "present" },
    },
    assertSourceCurrent: () => source.signal.throwIfAborted(),
  });
  const admitted = authority === "admitted" ? await admission.admit("embedded") : undefined;
  const close = () => admission.close();
  const revoke = admitted
    ? () => runAuthority.closeAdmittedRunDelegatedAuthority(admitted)
    : () => source.abort(new Error("source authority revoked"));
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
  provider: ReturnType<typeof createProvider>,
  runId: string,
  runLocal = localResult,
) {
  return provider.executeTurn(runIdentity(runId), fx.turn(runId), runLocal);
}

export function environmentForTunnel(
  overrides: Pick<Environments, "startTunnel"> & Partial<Environments>,
): Environments {
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
