import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../../runtime.js";
import { WizardSession } from "../../wizard/session.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";
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
  pendingSessionIds: Set<string>;
  session: Promise<{ sessionId: string; session: WizardSession } | "superseded" | undefined>;
};
const authWizardRequests = new WeakMap<
  GatewayRequestContext["wizardSessions"],
  AuthWizardRequest
>();

async function createSetupActivationSession(
  params: {
    sessionId: string;
    ownerKey?: string;
    activation: SetupActivation;
    context: GatewayRequestContext;
  },
  createSession: () => WizardSession,
): Promise<WizardSession | "superseded" | undefined> {
  const { ownerKey, activation } = params;
  if (!ownerKey || activation.kind !== "provider-auth") {
    return createAdmittedWizardSession(createSession);
  }
  const sessions = params.context.wizardSessions;
  const previous = authWizardRequests.get(sessions);
  if (
    previous &&
    (previous.ownerKey !== ownerKey ||
      previous.activation.authChoice !== activation.authChoice ||
      previous.activation.agentId !== activation.agentId ||
      previous.activation.workspace !== activation.workspace ||
      previous.activation.modelTarget !== activation.modelTarget ||
      previous.activation.nativeSessionCatalogsEnabled !== activation.nativeSessionCatalogsEnabled)
  ) {
    return undefined;
  }
  const request: AuthWizardRequest = {
    ownerKey,
    activation,
    pendingSessionIds: previous?.pendingSessionIds ?? new Set(),
    session: Promise.resolve().then(async () => {
      if (previous) {
        const predecessor = await previous.session;
        if (predecessor && predecessor !== "superseded") {
          if (predecessor.session.getStatus() === "running" && !predecessor.session.cancel()) {
            // Preparation locks can lift later; rejected retries must retain that owner.
            return predecessor;
          }
          // Cancellation retires prompts before provider sockets and the setup lock.
          // Every queued replacement inherits this barrier, even if superseded.
          await whenAdmittedWizardSessionSettled(predecessor.session);
          if (sessions.get(predecessor.sessionId) === predecessor.session) {
            params.context.purgeWizardSession(predecessor.sessionId);
          }
        }
      }
      if (authWizardRequests.get(sessions) !== request) {
        return "superseded";
      }
      const session = await createAdmittedWizardSession(createSession);
      return session ? { sessionId: params.sessionId, session } : undefined;
    }),
  };
  // Reserve before awaiting admission so only the newest request can start login.
  authWizardRequests.set(sessions, request);
  request.pendingSessionIds.add(params.sessionId);
  const release = () => {
    if (authWizardRequests.get(sessions) === request) {
      authWizardRequests.delete(sessions);
    }
  };
  try {
    const session = await request.session;
    if (session && session !== "superseded") {
      void whenAdmittedWizardSessionSettled(session.session).then(release, release);
      return session.sessionId === params.sessionId ? session.session : undefined;
    } else {
      release();
    }
    return session;
  } catch (error) {
    release();
    throw error;
  } finally {
    request.pendingSessionIds.delete(params.sessionId);
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
    !authWizardRequests.get(sessions)?.pendingSessionIds.has(params.sessionId)
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
            runtime: {
              ...defaultRuntime,
              exit: (code: number | undefined): never => {
                throw new Error(`setup step exited with code ${String(code)}`);
              },
            },
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
  if (session === "superseded") {
    params.respond(
      true,
      { sessionId: params.sessionId, done: true, status: "cancelled" },
      undefined,
    );
    return;
  }
  params.context.wizardSessions.set(params.sessionId, session);
  // Return ownership before any prompt so cancellation survives a lost start reply.
  params.respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
}
