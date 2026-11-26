import type {
  SessionRow,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { bindDeferredSelfSnoozePatch } from "../../gateway/server-methods/sessions-patch-self-snooze.js";
import { resolveSessionSnoozeError } from "../../gateway/sessions-patch-lifecycle-flags.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { readSessionControllerOperationState } from "../../sessions/session-controller.state.js";
import { captureSelfSnooze } from "../../sessions/session-self-snooze.js";
import { jsonResult, ToolInputError } from "./common.js";
import {
  getInProcessGatewayToolContext,
  runWithGatewayToolContinuationContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-access.js";
import {
  callSessionToolControl,
  prepareSessionToolControlTarget,
} from "./sessions-tool-control.js";
import { reportDeferredSessionVisibilityFailure } from "./sessions-tool-deferred-notice.js";

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
  // Visibility belongs to the chat; an error notice belongs only to the requesting transcript.
  const reportSessionId = requestingTurn.sessionId;
  const gateway = getInProcessGatewayToolContext();
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
        const write = new AbortController();
        const request = {
          method: "sessions.patch",
          signal: write.signal,
          params: bindDeferredSelfSnoozePatch(patch, chat),
          sessionMutationCommitGuard: composeSessionSourceAssertion([], intent.assertCurrent, {
            synchronousCheck: true,
          }),
        };
        try {
          if (control.restricted) {
            await callSessionToolControl(control, request, callGateway);
          } else {
            await callGateway(request);
          }
        } catch {
          // A timeout can leave the Gateway handler running. Stop any uncommitted write
          // before observing its outcome; never send the patch again.
          write.abort();
          if (!intent.current() || getInProcessGatewayToolContext() !== gateway) {
            return;
          }
          const access = control.restricted
            ? await prepareSessionToolControlTarget(control)
            : undefined;
          try {
            const assertCurrent = composeSessionSourceAssertion([
              request.sessionMutationCommitGuard,
              access?.assertCurrent,
            ]);
            // Describe uses the continuing caller's read permissions. A missing or
            // unreadable row is not evidence that the snooze failed.
            const described = await callGateway<{ session: SessionRow | null }>({
              method: "sessions.describe",
              params: { key, agentId },
              sessionMutationCommitGuard: assertCurrent,
            }).catch(() => undefined);
            if (!intent.current() || until <= Date.now()) {
              return;
            }
            const row = described?.session;
            const observed = row?.key === key;
            if (observed && row.snoozedUntil === until) {
              return;
            }
            await reportDeferredSessionVisibilityFailure({
              operation: "snooze",
              outcome: observed ? "failed" : "unconfirmed",
              target: { ...chat, sessionId: reportSessionId },
              gateway,
              assertCurrent,
            });
          } finally {
            access?.release();
          }
        }
      },
      { agentId },
    )
      .catch(() => {
        if (intent.current()) {
          log.warn("deferred self-snooze outcome unavailable for " + key);
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
