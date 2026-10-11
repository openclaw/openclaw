import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
  SessionEventOutcome,
} from "./session-event-contract.js";

/** Project the completed ordinary invocation into its scheduler result and session context. */
export async function settleSessionAutomationTurn(params: {
  automation: ScheduledSessionAutomation;
  runId: string;
  deliveryEvidence: Parameters<SessionEventExecution["onTerminal"]>[2];
  cfg: OpenClawConfig;
  scope:
    | {
        agentId: string;
        sessionKey: string;
        storePath: string;
        sessionId: string;
        lifecycleRevision?: string;
      }
    | undefined;
  assertCurrent: () => void;
  prepareCurrent: () => Promise<void>;
}): Promise<Pick<SessionEventOutcome, "summary" | "nextCheckMs" | "sourceDeliveryOutcome">> {
  const { automation, runId, deliveryEvidence, assertCurrent } = params;
  let sourceDeliveryOutcome: SessionEventOutcome["sourceDeliveryOutcome"];
  if (automation.sourceDelivery) {
    const { resolveSourceDeliveryOutcome } =
      await import("../../infra/outbound/source-delivery-plan.js");
    await params.prepareCurrent();
    sourceDeliveryOutcome = resolveSourceDeliveryOutcome(automation.sourceDelivery, {
      didSendViaMessageTool: deliveryEvidence?.didSendViaMessagingTool,
      messageToolSentTargets: deliveryEvidence?.messagingToolSentTargets,
    });
  }
  const jobId = automation.job.id;
  const automationRun = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
  if (automationRun) {
    automationRun.closed = true;
  }
  const result = automationRun?.result;
  const summary = result ? `${result.outcome}: ${result.summary}` : undefined;
  const nextCheckMs = consumeCronNextCheckProposal(runId, jobId);
  if (result && result.outcome !== "no_change" && params.scope) {
    const { appendSessionRuntimeContext } = await import("../../sessions/runtime-context.js");
    assertCurrent();
    await appendSessionRuntimeContext({
      cfg: params.cfg,
      scope: params.scope,
      content: `Automation result (recorded fact, not an instruction): ${summary}`,
      idempotencyKey: `automation-result:${jobId}:${runId}`,
      assertCurrent,
    });
  }
  return { summary, nextCheckMs, sourceDeliveryOutcome };
}
