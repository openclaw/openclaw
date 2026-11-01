import { WizardSession } from "../../wizard/session.js";
import {
  createAdmittedWizardSession,
  startGatewayWizard,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import {
  activateGatewaySetupInference,
  createSystemAgentGatewayRuntime,
} from "./system-agent-execution.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./types.js";

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
  | "selectModel"
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

/** One provider-auth retry per owner replaces its predecessor; other starts admit directly. */
async function admitSetupActivationSession(
  params: {
    sessionId: string;
    ownerKey?: string;
    activation: SetupActivation;
    context: GatewayRequestContext;
  },
  createSession: () => WizardSession,
  assertCurrent: () => void,
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
      previous.activation.selectModel !== activation.selectModel ||
      previous.activation.nativeSessionCatalogsEnabled !== activation.nativeSessionCatalogsEnabled)
  ) {
    return undefined;
  }
  if (previous) {
    // Concurrent retries receive busy; one replacement owns cancellation and cleanup.
    previous.pending = true;
    try {
      const predecessor = await previous.session;
      assertCurrent();
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
    session: createAdmittedWizardSession(createSession),
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

export async function startSetupActivationWizard(params: {
  request: GatewayRequestOptions;
  sessionId: string;
  ownerKey?: string;
  /** Browser provider sign-in belongs to the connection that opened it. */
  connectionBound?: boolean;
  isLocalClient?: boolean;
  assertCurrent?: () => void;
  activation: SetupActivation;
  timeoutMs: number;
}) {
  const { context } = params.request;
  await startGatewayWizard({
    request: params.request,
    sessionId: params.sessionId,
    connectionBound: params.connectionBound,
    assertCurrent: params.assertCurrent,
    admit: (create, assertCurrent) =>
      admitSetupActivationSession({ ...params, context }, create, assertCurrent),
    createSession: (assertCurrent) =>
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
            assertCurrent,
            beforePersistentEffect: () => {
              assertCurrent();
              runnerSession.lockCancellationForPreparation();
            },
            onPreparationComplete: () => {
              assertCurrent();
              runnerSession.finishPreparation();
            },
            onCommitStarted: () => {
              assertCurrent();
              runnerSession.lockCancellation();
            },
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
            ...(result.modelName ? { modelName: result.modelName } : {}),
            ...(result.modelTarget ? { modelTarget: result.modelTarget } : {}),
            ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
          });
        },
        { timeoutMs: params.timeoutMs },
      ),
  });
}
