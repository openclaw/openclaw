import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { WizardSession } from "../../wizard/session.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import {
  activateGatewaySetupInference,
  createSystemAgentGatewayRuntime,
} from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type SetupActivation = Pick<
  Parameters<typeof activateGatewaySetupInference>[0],
  | "kind"
  | "agentId"
  | "modelRef"
  | "modelTarget"
  | "authChoice"
  | "apiKey"
  | "workspace"
  | "nativeSessionCatalogsEnabled"
>;
type AuthWizardRequest = {
  ownerKey: string;
  activation: SetupActivation;
  sessionId: string;
  pending: boolean;
  session: Promise<WizardSession | undefined>;
};
const authWizardRequests = new WeakMap<
  GatewayRequestContext["wizardSessions"],
  AuthWizardRequest
>();

async function createSetupActivationSession(
  params: {
    sessionId: string;
    ownerKey?: string;
    assertCurrent?: () => void;
    activation: SetupActivation;
    context: GatewayRequestContext;
  },
  createSession: () => WizardSession,
): Promise<WizardSession | undefined> {
  const { ownerKey, activation } = params;
  if (!ownerKey || activation.kind !== "provider-auth") {
    return createAdmittedWizardSession(createSession);
  }
  const sessions = params.context.wizardSessions;
  const previous = authWizardRequests.get(sessions);
  if (
    previous &&
    (previous.pending ||
      previous.ownerKey !== ownerKey ||
      previous.activation.authChoice !== activation.authChoice ||
      previous.activation.agentId !== activation.agentId ||
      previous.activation.workspace !== activation.workspace ||
      previous.activation.modelTarget !== activation.modelTarget ||
      previous.activation.nativeSessionCatalogsEnabled !== activation.nativeSessionCatalogsEnabled)
  ) {
    return undefined;
  }
  if (previous) {
    // Concurrent retries receive busy; one replacement owns cancellation and cleanup.
    previous.pending = true;
    try {
      const predecessor = await previous.session;
      params.assertCurrent?.();
      if (predecessor) {
        if (predecessor.getStatus() === "running" && !predecessor.cancel()) {
          return undefined;
        }
        await whenAdmittedWizardSessionSettled(predecessor);
        params.context.purgeWizardSession(previous.sessionId);
      }
    } finally {
      previous.pending = false;
    }
  }
  const request: AuthWizardRequest = {
    ownerKey,
    activation,
    sessionId: params.sessionId,
    pending: true,
    session: createAdmittedWizardSession(() => {
      params.assertCurrent?.();
      return createSession();
    }),
  };
  authWizardRequests.set(sessions, request);
  const release = () => {
    if (authWizardRequests.get(sessions) === request) {
      authWizardRequests.delete(sessions);
    }
  };
  try {
    const session = await request.session;
    if (session) {
      void whenAdmittedWizardSessionSettled(session).then(release, release);
    } else {
      release();
    }
    return session;
  } catch (error) {
    release();
    throw error;
  } finally {
    request.pending = false;
  }
}

export function rejectExistingSetupWizardSession(params: {
  sessionId: string;
  context: GatewayRequestContext;
  respond: RespondFn;
}): boolean {
  const sessions = params.context.wizardSessions;
  if (
    !sessions.has(params.sessionId) &&
    authWizardRequests.get(sessions)?.sessionId !== params.sessionId
  ) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
  );
  return true;
}

export async function startSetupActivationWizard(params: {
  sessionId: string;
  ownerKey?: string;
  assertCurrent?: () => void;
  activation: SetupActivation;
  isLocalClient?: boolean;
  timeoutMs: number;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  if (rejectExistingSetupWizardSession(params)) {
    return;
  }
  const session = await createSetupActivationSession(
    params,
    () =>
      new WizardSession(
        async (prompter, signal, runnerSession) => {
          const result = await activateGatewaySetupInference({
            ...params.activation,
            surface: "gateway",
            isRemoteProviderAuth: params.isLocalClient !== true,
            runtime: createSystemAgentGatewayRuntime(),
            prompter,
            signal,
            isCancelled: () => signal.aborted,
            beforePersistentEffect: () => runnerSession.lockCancellationForPreparation(),
            onPreparationComplete: () => runnerSession.finishPreparation(),
            onCommitStarted: () => runnerSession.lockCancellation(),
          });
          signal.throwIfAborted();
          if (!result.ok) {
            if (result.disposition === "rejected-before-promotion") {
              runnerSession.setActivationRejection({
                disposition: result.disposition,
                status: result.status,
              });
            }
            throw new Error(result.error);
          }
          runnerSession.setModelActivation({
            modelRef: result.modelRef,
            ...(result.modelTarget ? { modelTarget: result.modelTarget } : {}),
            ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
          });
        },
        { timeoutMs: params.timeoutMs },
      ),
  );
  if (!session) {
    respondSetupAdmissionBusy(params.respond);
    return;
  }
  params.context.wizardSessions.set(params.sessionId, session);
  // Return ownership before any prompt so cancellation survives a lost start reply.
  params.respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
}
