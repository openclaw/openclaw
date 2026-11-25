import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import { isWizardSessionUnwatched, noteWizardReader } from "../server-wizard-sessions.js";
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
  sessionId: string;
  pending: boolean;
  session: Promise<WizardSession | undefined>;
  started?: WizardSession;
};
const authWizardRequests = new WeakMap<
  GatewayRequestContext["wizardSessions"],
  AuthWizardRequest
>();

/**
 * A provider sign-in outlives its socket, so the user can come back to it. A new
 * sign-in replaces it when it is the same owner's, or when the connection that last
 * started or read it is gone; otherwise an abandoned tab would hold setup admission
 * until its timeout.
 */
export async function admitProviderSignIn(
  params: {
    sessionId: string;
    ownerKey: string;
    starter: GatewayRequestOptions["client"];
    context: GatewayRequestContext;
  },
  createSession: () => WizardSession,
  assertCurrent: () => void,
): Promise<WizardSession | undefined> {
  const { ownerKey } = params;
  const sessions = params.context.wizardSessions;
  const previous = authWizardRequests.get(sessions);
  if (
    previous &&
    (previous.pending ||
      (previous.ownerKey !== ownerKey &&
        !(previous.started && isWizardSessionUnwatched(previous.started))))
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
      request.started = session;
      noteWizardReader(session, params.starter);
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
  isLocalClient?: boolean;
  assertCurrent?: () => void;
  activation: SetupActivation;
  timeoutMs: number;
}) {
  const { context, client } = params.request;
  const { ownerKey } = params;
  await startGatewayWizard({
    request: params.request,
    sessionId: params.sessionId,
    assertCurrent: params.assertCurrent,
    ...(ownerKey && params.activation.kind === "provider-auth"
      ? {
          admit: (create: () => WizardSession, assertCurrent: () => void) =>
            admitProviderSignIn(
              { sessionId: params.sessionId, ownerKey, starter: client, context },
              create,
              assertCurrent,
            ),
        }
      : {}),
    createSession: (assertCurrent) =>
      new WizardSession(
        (prompter, signal, runnerSession) =>
          runSetupActivation({
            activation: params.activation,
            isLocalClient: params.isLocalClient,
            prompter,
            signal,
            runnerSession,
            assertCurrent,
          }),
        { timeoutMs: params.timeoutMs },
      ),
  });
}

/** Runs one setup activation in a wizard session and records the live-verified model. */
export async function runSetupActivation(params: {
  activation: SetupActivation;
  isLocalClient?: boolean;
  prompter: WizardPrompter;
  signal: AbortSignal;
  runnerSession: WizardSession;
  assertCurrent: () => void;
}): Promise<void> {
  const { prompter, signal, runnerSession, assertCurrent } = params;
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
}
