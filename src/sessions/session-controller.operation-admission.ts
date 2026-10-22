import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { assertTurnAdmission } from "./session-controller.admission-rule.js";
import type {
  SessionControllerMailboxClaim,
  SessionControllerOperation,
  SessionControllerTurnKind,
} from "./session-controller.contracts.js";
import { notify } from "./session-controller.lifecycle-state.js";
import {
  bindSessionControllerTarget,
  retainSessionControllerOperation,
} from "./session-controller.lifecycle.js";
import {
  getSessionControllerEntry,
  bindSessionControllerEntryTarget,
  sessionControllers,
  addSessionControllerEntryAlias,
  controllerEntryByOperation,
  notifyReplyRunEnded,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import type { SessionTarget } from "./session-controller.target.js";

export type CreateReplyOperationParams = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  turnKind?: SessionControllerTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  upstreamAbortSignal?: AbortSignal;
  mailboxClaim?: SessionControllerMailboxClaim;
  target?: SessionTarget;
};

export function prepareReplyOperationAdmission(params: CreateReplyOperationParams) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  const owner =
    params.mailboxClaim?.mailbox.owner ?? getSessionControllerEntry(sessionKey, params.target);
  if (params.target) {
    bindSessionControllerEntryTarget(owner, params.target);
  }
  assertTurnAdmission(owner, {
    kind: params.turnKind ?? "visible",
    sessionKey,
    registeredEntry: sessionControllers.get(owner.id),
    claim: params.mailboxClaim,
  });
  return { sessionKey, sessionId, owner };
}

/** Publishes the prepared operation's context, exact owner, and retained custody. */
export function installReplyOperationAdmission(
  operation: SessionControllerOperation,
  admitted: ReturnType<typeof prepareReplyOperationAdmission>,
  mailboxClaim?: SessionControllerMailboxClaim,
): void {
  const { owner, sessionId } = admitted;
  bindGatewayContextResolver(
    operation,
    mailboxClaim
      ? getGatewayContextResolver(mailboxClaim)
      : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  );
  owner.active = operation;
  const projectSessionActive = mailboxClaim?.inputs[0]?.sourceAdapter?.projectSessionActive;
  if (projectSessionActive !== undefined) {
    owner.attachment = { operation, projectSessionActive };
  }
  // Lifecycle retention and target binding consume the exact installed owner.
  addSessionControllerEntryAlias(owner, sessionId);
  controllerEntryByOperation.set(operation, owner);
  retainSessionControllerOperation(operation);
  if (owner.target) {
    bindSessionControllerTarget(operation, owner.target);
  }
  if (mailboxClaim) {
    mailboxClaim.operation = operation;
  }
  notify(owner);
}

/** Move the exact operation; old source custody remains retained until its producer settles. */
export function adoptReplyOperationController(
  operation: SessionControllerOperation,
  previousOwner: SessionControllerEntry,
  owner: SessionControllerEntry,
  target: SessionTarget | undefined,
  mailboxClaim?: SessionControllerMailboxClaim,
): void {
  if (owner !== previousOwner) {
    previousOwner.active = undefined;
    // An unbound reservation has no physical producer custody at its former key.
    if (!previousOwner.target && !previousOwner.mailbox) {
      previousOwner.lifecycle?.operations.delete(operation);
      notify(previousOwner);
    }
  }
  owner.active = operation;
  addSessionControllerEntryAlias(owner, operation.sessionId);
  controllerEntryByOperation.set(operation, owner);
  retainSessionControllerOperation(operation);
  if (mailboxClaim) {
    mailboxClaim.operation = operation;
  }
  if (target) {
    bindSessionControllerTarget(operation, target);
  }
  if (previousOwner !== owner) {
    notifyReplyRunEnded(previousOwner);
  }
}
