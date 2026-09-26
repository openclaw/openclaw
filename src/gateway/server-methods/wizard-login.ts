import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { WizardSession } from "../../wizard/session.js";
import { bindWizardLoginOwner } from "../server-wizard-sessions.js";
import type { GatewayClient } from "./client-types.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export async function startWizardLogin(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionId: string;
  respond: RespondFn;
  assertCurrent: () => void;
  createSession: () => WizardSession;
}): Promise<void> {
  const { client, context, sessionId, respond } = params;
  const session = await createAdmittedWizardSession(() => {
    params.assertCurrent();
    return params.createSession();
  });
  if (!session) {
    respondSetupAdmissionBusy(respond);
    return;
  }
  try {
    params.assertCurrent();
  } catch {
    session.close(new Error("Login is no longer available on this connection."));
    await whenAdmittedWizardSessionSettled(session);
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Login is no longer available on this connection."),
    );
    return;
  }
  bindWizardLoginOwner(session, client);
  context.wizardSessions.set(sessionId, session);
  const cancel = () => session.close(new Error("Login connection closed."));
  client.connectionSignal?.addEventListener("abort", cancel, { once: true });
  const settled = () => {
    client.connectionSignal?.removeEventListener("abort", cancel);
    if (client.connectionSignal?.aborted || client.invalidated) {
      context.purgeWizardSession(sessionId);
    }
  };
  void whenAdmittedWizardSessionSettled(session).then(settled, settled);
  respond(true, { sessionId, done: false, status: "running" }, undefined);
}
