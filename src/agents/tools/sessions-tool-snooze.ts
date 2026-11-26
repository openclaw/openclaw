import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindDeferredSelfSnoozePatch } from "../../gateway/server-methods/sessions-patch-self-snooze.js";
import { resolveSessionSnoozeError } from "../../gateway/sessions-patch-lifecycle-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
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
  cfg: OpenClawConfig;
  key: string;
  agentId: string;
  expectedSessionId: string;
  until: number;
  runSessionId?: string;
  runId?: string;
  singleField: boolean;
  inProcessGatewayAvailable: boolean;
  controlOnly: boolean;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const { cfg, key, agentId, expectedSessionId, until, callGateway } = params;
  if (!params.singleField) {
    throw new ToolInputError("Snooze the current session in a separate patch");
  }
  if (!params.inProcessGatewayAvailable) {
    throw new ToolInputError("Self-snooze requires the running Gateway");
  }
  if (expectedSessionId !== params.runSessionId?.trim()) {
    throw new ToolInputError("Self-snooze requires the current run's session identity");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const target = { agentId, sessionKey: key, sessionId: expectedSessionId, storePath };
  const requestingTurn = params.runId
    ? findSessionControllerOperationByRunId(params.runId)
    : getCurrentSessionControllerOwner();
  const turnState = readSessionControllerOperationState(requestingTurn);
  if (!turnState || requestingTurn?.sessionId !== expectedSessionId || requestingTurn.key !== key) {
    throw new ToolInputError("Self-snooze requires the active requesting turn");
  }
  const intent = captureSelfSnooze(target);
  try {
    const revision = await withSessionEntryReadOnlyInWorker(
      target,
      () => {},
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (read.value?.sessionId !== expectedSessionId || !owner.scope) {
          throw new ToolInputError("Self-snooze target changed");
        }
        intent.bindStore(owner.scope.storePath);
        const error = resolveSessionSnoozeError(cfg, key, read.value, until, Date.now());
        if (error) {
          throw new ToolInputError(error.message);
        }
        return read.value.lifecycleRevision;
      },
    );
    const control = {
      cfg,
      key,
      agentId,
      expectedSessionId,
      expectedLifecycleRevision: revision ?? null,
      operation: "snooze" as const,
      restricted: params.controlOnly,
    };
    if (params.controlOnly) {
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
          params: bindDeferredSelfSnoozePatch({
            key,
            expectedSessionId,
            ...(revision ? { expectedLifecycleRevision: revision } : {}),
            ...(parseAgentSessionKey(key) ? {} : { agentId }),
            snoozedUntil: until,
          }),
          sessionMutationCommitGuard: composeSessionSourceAssertion([], intent.assertCurrent, {
            synchronousCheck: true,
          }),
        };
        if (params.controlOnly) {
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
