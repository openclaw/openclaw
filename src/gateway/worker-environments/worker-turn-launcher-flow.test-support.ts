import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import type { WorkerTunnelHandle, WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  credential,
  SESSION_ID,
  sessionTarget,
  turn,
  openSessionManager,
  acknowledgeCompletedWorkerTurn,
  createWorkerSessionTurnPlacementProvider,
  placements,
  unusedEnvironments,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  reconcileUnchangedLocalWorkspace,
  setupWorkerTurnLauncherTest,
  cleanupWorkerTurnLauncherTest,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

export const localResult = async () => ({ meta: { durationMs: 1 } });

export function installLauncherTest() {
  afterAll(closeStateDatabaseForTest);
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
}

export const completedWorkerMessage = () =>
  makeAgentAssistantMessage({
    content: [{ type: "text", text: "Remote work completed" }],
    timestamp: 21,
  });

export function createLauncher(
  options: Partial<Parameters<typeof createWorkerSessionTurnPlacementProvider>[0]> = {},
) {
  const { environments = unusedEnvironments(), ...overrides } = options;
  return createWorkerSessionTurnPlacementProvider({ placements, environments, ...overrides });
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
  const leaf = await (
    await openSessionManager()
  ).appendMessageAsync(makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp }));
  return acknowledgeCompletedWorkerTurn(request.turnClaim, leaf);
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
  const base = turn(runId);
  let sourceLive = true;
  const admission = prepareAgentRunAdmission({
    cfg: base.config,
    operationalRunInstance: createOperationalRunInstanceRef(base.runId),
    facts: {
      runId,
      agentId: sessionTarget.agentId,
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
  return {
    input: {
      ...base,
      preparedRunAdmission: admitted ? undefined : admission,
      admittedRunContext: admitted,
    },
    revoke: () => {
      if (admitted) {
        closeAdmittedRunDelegatedAuthority(admitted);
      } else {
        sourceLive = false;
      }
    },
    close,
    [Symbol.dispose]: close,
  };
}

export function runIdentity(runId: string) {
  return {
    sessionId: SESSION_ID,
    sessionKey: sessionTarget.sessionKey,
    agentId: sessionTarget.agentId,
    runId,
  };
}

export function executeTurn(
  provider: ReturnType<typeof createWorkerSessionTurnPlacementProvider>,
  runId: string,
  runLocal = localResult,
) {
  return provider.executeTurn(runIdentity(runId), turn(runId), runLocal);
}

export function environmentForTunnel(
  overrides: Pick<WorkerTurnEnvironmentService, "startTunnel"> &
    Partial<WorkerTurnEnvironmentService>,
): WorkerTurnEnvironmentService {
  return {
    get: vi.fn(attachedEnvironment),
    acquireTurnCredential: vi.fn(async () => credential()),
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    stopTunnel: vi.fn(async () => {}),
    destroy: vi.fn(async () => attachedEnvironment()),
    ...overrides,
  };
}

export function remoteExecEnvironment(
  runWorkspaceCommand: WorkerTunnelHandle["runWorkspaceCommand"],
  onStart?: () => void,
) {
  const tunnel: WorkerTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand,
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    syncWorkspace: vi.fn(),
    stop: async () => {},
  };
  return {
    ...unusedEnvironments(),
    get: vi.fn(attachedEnvironment),
    startTunnel: vi.fn(async () => {
      onStart?.();
      return tunnel;
    }),
  };
}
