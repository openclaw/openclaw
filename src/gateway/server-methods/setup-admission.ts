import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  getGatewayRestartDrainSignal,
  retainGatewayRootWorkAdmissionContinuation,
} from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import type { WizardSession } from "../../wizard/session.js";
import {
  SetupTargetLockedError,
  withSetupMigrationTargetLock,
} from "../../wizard/setup.migration-snapshot.js";
import { captureOperatorToolGatewayContinuationContext } from "../server-plugin-in-process-authority.js";
import { bindWizardLoginOwner } from "../server-wizard-sessions.js";
import { retainGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestOptions, RespondFn } from "./types.js";

const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let wizardSessionInProgress = false;
const wizardSessionAdmissionSettlements = new WeakMap<object, Promise<unknown>>();

export class SetupAdmissionBusyError extends Error {}

/** Only admission failures may promise that no setup task or session began. */
export function respondSetupAdmissionBusy(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, SETUP_ADMISSION_BUSY_MESSAGE, {
      retryable: true,
      details: { code: GatewayErrorDetailCodes.SETUP_ADMISSION_BUSY },
    }),
  );
}

export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  let admitted = false;
  try {
    return await withSetupMigrationTargetLock(resolveStateDir(), async () => {
      admitted = true;
      return await task();
    });
  } catch (error) {
    if (!admitted && error instanceof SetupTargetLockedError) {
      throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
    }
    throw error;
  }
}

/** Resolves after both the wizard runner and its setup-target admission have settled. */
export function whenAdmittedWizardSessionSettled(session: {
  whenSettled(): Promise<unknown>;
}): Promise<unknown> {
  return wizardSessionAdmissionSettlements.get(session) ?? session.whenSettled();
}

export async function createAdmittedWizardSession(
  createSession: () => WizardSession,
  lockSetupTarget = true,
): Promise<WizardSession | undefined> {
  if (wizardSessionInProgress) {
    return undefined;
  }
  wizardSessionInProgress = true;
  // Keep the runner attached to the Gateway shutdown that admitted it.
  const gatewaySignal = getAsyncWorkSignal();
  const drainSignal = getGatewayRestartDrainSignal();
  const signal = gatewaySignal ? AbortSignal.any([gatewaySignal, drainSignal]) : drainSignal;
  let removeCloseListener: (() => void) | undefined;
  let releaseGatewayWork: (() => void) | null = null;
  const releaseSession = () => {
    removeCloseListener?.();
    releaseGatewayWork?.();
    wizardSessionInProgress = false;
  };
  try {
    const create = () => {
      signal.throwIfAborted();
      const session = createSession();
      const close = () =>
        session.close(
          new Error("Gateway is shutting down; restart it before continuing setup.", {
            cause: signal.reason,
          }),
        );
      signal.addEventListener("abort", close, { once: true });
      removeCloseListener = () => signal.removeEventListener("abort", close);
      return session;
    };
    let admissionSettled: Promise<unknown> | undefined;
    const session = lockSetupTarget
      ? await new Promise<WizardSession>((resolve, reject) => {
          admissionSettled = runExclusiveSystemAgentSetupActivation(async () => {
            const createdSession = create();
            resolve(createdSession);
            await createdSession.whenSettled();
          });
          void admissionSettled.catch(reject);
        })
      : create();
    const settled = trackAsyncWork(() => admissionSettled ?? session.whenSettled());
    wizardSessionAdmissionSettlements.set(session, settled);
    // The runner outlives its start RPC and inherits that request's admission.
    // Keep the root live so later prompts and post-auth probes remain subordinate work.
    releaseGatewayWork = retainGatewayRootWorkAdmissionContinuation();
    void settled.then(releaseSession, releaseSession);
    return session;
  } catch (error) {
    releaseSession();
    if (error instanceof SetupAdmissionBusyError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Owns every Gateway-started background wizard. The runner outlives its start
 * reply, so the starting operator's grant is retained before that reply and
 * stays revocable until the runner settles. Connection-bound wizards (browser
 * sign-in) also stop when the starting connection closes.
 */
export async function startGatewayWizard(params: {
  request: GatewayRequestOptions;
  sessionId: string;
  connectionBound?: boolean;
  lockSetupTarget?: boolean;
  /** Caller-specific facts that must stay unchanged, such as the selected login. */
  assertCurrent?: () => void;
  admit?: (
    create: () => WizardSession,
    assertCurrent: () => void,
  ) => Promise<WizardSession | undefined>;
  createSession: (assertCurrent: () => void) => WizardSession;
  /** Replaces the default running reply, after the session is registered. */
  respondStarted?: (session: WizardSession) => Promise<void>;
}): Promise<void> {
  const { client, context, respond } = params.request;
  const reject = (message: string) =>
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  if (context.wizardSessions.has(params.sessionId)) {
    reject("wizard session already exists");
    return;
  }
  const connection = params.connectionBound ? client : undefined;
  if (params.connectionBound && !connection) {
    reject("Client required");
    return;
  }
  let authority: ReturnType<typeof retainGatewayRequestMutationAuthority> | undefined;
  let continuation: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
  const release = () => {
    authority?.release();
    continuation?.release();
  };
  const assertCurrent = () => {
    connection?.connectionSignal?.throwIfAborted();
    params.assertCurrent?.();
    continuation?.assertCurrent();
    authority?.assertCurrent();
  };
  let session: WizardSession | undefined;
  try {
    authority = retainGatewayRequestMutationAuthority(params.request);
    continuation = await captureOperatorToolGatewayContinuationContext();
    const create = () => {
      assertCurrent();
      // The runner starts in its constructor and inherits this retained scope.
      const createSession = () => params.createSession(assertCurrent);
      return continuation ? continuation.run(createSession) : createSession();
    };
    session = await (params.admit?.(create, assertCurrent) ??
      createAdmittedWizardSession(create, params.lockSetupTarget));
  } catch (error) {
    release();
    throw error;
  }
  if (!session) {
    release();
    respondSetupAdmissionBusy(respond);
    return;
  }
  const started = session;
  void whenAdmittedWizardSessionSettled(started).then(release, release);
  try {
    assertCurrent();
  } catch {
    started.close(new Error("Setup is no longer available on this connection."));
    await whenAdmittedWizardSessionSettled(started);
    reject("Setup is no longer available on this connection.");
    return;
  }
  if (connection) {
    bindWizardLoginOwner(started, connection);
    const signal = connection.connectionSignal;
    const cancel = () => started.close(new Error("Login connection closed."));
    signal?.addEventListener("abort", cancel, { once: true });
    const settled = () => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted || connection.invalidated) {
        context.purgeWizardSession(params.sessionId);
      }
    };
    void whenAdmittedWizardSessionSettled(started).then(settled, settled);
  }
  context.wizardSessions.set(params.sessionId, started);
  if (params.respondStarted) {
    await params.respondStarted(started);
    return;
  }
  // Return ownership before any prompt so cancellation survives a lost start reply.
  respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
}
