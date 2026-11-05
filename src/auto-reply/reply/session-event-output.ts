import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { settleSessionEventTurn } from "./session-event-automation.js";
import type {
  SessionEventExecution,
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventTarget,
} from "./session-event-contract.js";
import { prepareSessionEventDelivery } from "./session-event-delivery.js";
import { getSessionEventRuntimeConfig } from "./session-event-target.js";

type SessionEventOutput = Pick<
  SessionEventOutcome,
  | "delivered"
  | "conversationResultCommitted"
  | "deliveryAttempted"
  | "deliveryAmbiguous"
  | "deliveryError"
  | "summary"
  | "terminalOutcome"
  | "nextCheckMs"
  | "sourceDeliveryOutcome"
  | "automationResult"
>;

/** Accumulate reply/transport evidence; admission and source currency stay with the handoff. */
export function bindSessionEventOutput(params: {
  options: SessionEventOptions;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  runStartedAt: number;
  signal: AbortSignal;
  prepareCurrent: () => Promise<void>;
  assertCurrent: () => void;
  assertEffectCurrent: () => void;
  target: () => SessionEventTarget | undefined;
  route: () => DeliveryContext | undefined;
  binding: () => Pick<SessionEventTarget, "sessionId" | "lifecycleRevision"> | undefined;
  operationSignal: () => AbortSignal | undefined;
  onFailure: (error: string) => void;
}) {
  const {
    options,
    cfg,
    agentId,
    sessionKey,
    storePath,
    signal,
    prepareCurrent,
    assertCurrent,
    assertEffectCurrent,
  } = params;
  const output: SessionEventOutput = {
    delivered: false,
    deliveryAttempted: false,
    deliveryAmbiguous: false,
  };
  const deliver = async (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    await prepareCurrent();
    const target = params.target();
    const route = params.route();
    if (kind === "final" && payload.text) {
      output.summary ??= truncateUtf16Safe(payload.text, 2000);
    }
    if (
      options.deliver === false ||
      target?.deliver === false ||
      (options.suppressErrorDelivery && payload.isError === true)
    ) {
      return;
    }
    if (kind === "final" && output.sourceDeliveryOutcome?.satisfiesSourceDelivery) {
      return;
    }
    if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
      // The normal transcript remains the result for internal/WebChat turns.
      // This is not evidence of a transport send.
      return;
    }
    const deliverReply = await prepareSessionEventDelivery(route, assertCurrent);
    output.deliveryAttempted = true;
    const assertDeliveryCurrent = () => {
      assertEffectCurrent();
      options.scheduledAutomation?.assertDeliveryCurrent?.();
    };
    const result = await deliverReply({
      cfg: getSessionEventRuntimeConfig(),
      agentId,
      sessionKey,
      payload,
      replyKind: kind,
      abortSignal: signal,
      beforeDeliver: async () => {
        await options.scheduledAutomation?.beforeDeliver?.();
        assertDeliveryCurrent();
      },
      assertCurrent: assertDeliveryCurrent,
    });
    output.delivered ||= result.delivered;
    output.deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      if (!options.scheduledAutomation) {
        throw new Error(result.error ?? "Session event delivery failed");
      }
      // Cron records transport failure separately from completed agent work.
      output.deliveryError = result.error ?? "Session event delivery failed";
    }
  };
  const onTerminal: SessionEventExecution["onTerminal"] = async (
    runId,
    outcome,
    deliveryEvidence,
  ) => {
    // Settlement rechecks authority and can reject after Stop. Capture the
    // runtime's timeout/cancellation facts before that asynchronous boundary.
    output.terminalOutcome = mergeAgentRunTerminalOutcome(
      output.terminalOutcome,
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: outcome === "completed" ? "end" : "error",
        data: deliveryEvidence?.meta,
        abortSignal: params.operationSignal() ?? signal,
      }),
    );
    const terminal = await settleSessionEventTurn({
      automation: options.scheduledAutomation,
      config: { ...cfg, session: { ...cfg.session, store: storePath } },
      agentId,
      sessionKey,
      binding: params.binding(),
      runStartedAt: params.runStartedAt,
      signal,
      assertCurrent: assertEffectCurrent,
      onFailure: params.onFailure,
      runId,
      deliveryEvidence,
      prepareCurrent,
      outcome,
    });
    output.summary = terminal.summary ?? output.summary;
    output.nextCheckMs = terminal.nextCheckMs;
    output.sourceDeliveryOutcome = terminal.sourceDeliveryOutcome;
    output.automationResult = terminal.automationResult;
    output.conversationResultCommitted = terminal.conversationResultCommitted;
    output.delivered ||= output.sourceDeliveryOutcome?.satisfiesSourceDelivery === true;
  };
  return { output, deliver, onTerminal };
}

/** Project the settled controller facts without changing execution or delivery custody. */
export function finishSessionEventOutput(
  output: SessionEventOutput,
  operation: ReplyOperation | undefined,
  failure: Error | string | undefined,
  signal: AbortSignal,
): {
  status: SessionEventOutcome["status"];
  terminalOutcome: NonNullable<SessionEventOutcome["terminalOutcome"]>;
} {
  const result = operation?.result;
  const failed = result?.kind === "failed";
  const aborted = result?.kind === "aborted";
  const terminalSignal = operation?.abortSignal.aborted ? operation.abortSignal : signal;
  const terminalError = (failed ? result.cause : undefined) ?? failure;
  // Frozen supersession records cancellation without aborting its signal.
  // Watchdog failures may abort the backend without being cancellation;
  // retain typed deadline facts ahead of the recorded cancellation defaults.
  output.terminalOutcome = mergeAgentRunTerminalOutcome(
    output.terminalOutcome,
    buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: failed || aborted || failure ? "error" : "end",
      data: {
        ...(aborted ? { aborted: true } : {}),
        ...(aborted && result.code === "aborted_for_supersession"
          ? { stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON }
          : {}),
        ...resolveAgentRunErrorLifecycleFields(
          terminalError ?? terminalSignal.reason,
          failed ? undefined : terminalSignal,
        ),
        ...resolveAgentRunErrorLifecycleFields(terminalError ?? terminalSignal.reason, undefined),
        error: terminalError,
      },
      abortSignal: failed ? undefined : terminalSignal,
    }),
  );
  const classification = classifyAgentRunTerminalOutcome(output.terminalOutcome);
  const status =
    classification === "cancellation"
      ? "cancelled"
      : classification === "success"
        ? "completed"
        : "failed";
  return { status, terminalOutcome: output.terminalOutcome };
}
