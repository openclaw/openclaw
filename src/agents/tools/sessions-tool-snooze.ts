import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { bindDeferredSelfSnoozePatch } from "../../gateway/server-methods/sessions-patch-self-snooze.js";
import { resolveSessionSnoozeError } from "../../gateway/sessions-patch-lifecycle-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { readSessionControllerOperationState } from "../../sessions/session-controller.state.js";
import { captureSelfSnooze } from "../../sessions/session-self-snooze.js";
import { jsonResult, ToolInputError } from "./common.js";
import {
  runWithGatewayToolContinuationContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-access.js";
import {
  callSessionToolControl,
  prepareSessionToolControlTarget,
} from "./sessions-tool-control.js";

const log = createSubsystemLogger("agents/sessions");

export async function scheduleSelfSnooze(params: {
  control: Parameters<typeof prepareSessionToolControlTarget>[0];
  checkSelection: boolean;
  patch: SessionsPatchParams & { snoozedUntil: number };
  runId?: string;
  singleField: boolean;
  inProcessGatewayAvailable: boolean;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const { control, patch, callGateway } = params;
  const { cfg, key, agentId } = control;
  const until = patch.snoozedUntil;
  if (!params.singleField) {
    throw new ToolInputError("Snooze the current session in a separate patch");
  }
  if (!params.inProcessGatewayAvailable) {
    throw new ToolInputError("Self-snooze requires the running Gateway");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const target = { agentId, sessionKey: key, storePath };
  const requestingTurn = params.runId
    ? findSessionControllerOperationByRunId(params.runId)
    : getCurrentSessionControllerOwner();
  const turnState = readSessionControllerOperationState(requestingTurn);
  if (
    !turnState ||
    requestingTurn?.key !== key ||
    (requestingTurn.agentId && requestingTurn.agentId !== agentId)
  ) {
    throw new ToolInputError("Self-snooze requires the active requesting turn");
  }
  const intent = captureSelfSnooze(target);
  try {
    const chat = await withSessionEntryReadOnlyInWorker(
      target,
      () => {},
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (!read.value || !owner.scope) {
          throw new ToolInputError("The chat selected for self-snooze is unavailable.");
        }
        const error = resolveSessionSnoozeError(cfg, key, read.value, until, Date.now());
        if (error) {
          throw new ToolInputError(error.message);
        }
        return intent.bindStore(owner.scope.storePath);
      },
    );
    if (control.restricted || params.checkSelection) {
      (await prepareSessionToolControlTarget(control)).release();
    }
    intent.admit();
    // The exact turn owns final delivery and persistence. A successor never stands in for it.
    void runWithGatewayToolContinuationContext(
      async () => {
        await requestingTurn.ownerSettlement;
        if (!intent.current() || until <= Date.now() || turnState.phase !== "completed") {
          return;
        }
        const request = {
          method: "sessions.patch",
          params: bindDeferredSelfSnoozePatch(patch, chat),
          sessionMutationCommitGuard: composeSessionSourceAssertion([], intent.assertCurrent, {
            synchronousCheck: true,
          }),
        };
        if (control.restricted) {
          await callSessionToolControl(control, request, callGateway);
        } else {
          await callGateway(request);
        }
      },
      { agentId },
    )
      .catch((error: unknown) => {
        if (intent.current()) {
          log.warn("deferred self-snooze failed for " + key + ": " + formatErrorMessage(error));
        }
      })
      .finally(intent.release);
  } catch (error) {
    intent.release();
    throw error;
  }
  recordSessionToolActionFact({
    operation: "patch",
    fact: "scheduled",
    targetAgentId: agentId,
    targetSessionKey: key,
  });
  return jsonResult({
    status: "scheduled",
    sessionKey: key,
    snoozedUntil: until,
    message:
      "After this reply the session will be snoozed unless newer user input arrives. Timed wake only restores visibility.",
  });
}
