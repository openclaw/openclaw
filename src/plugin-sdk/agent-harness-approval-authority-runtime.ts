import type {
  AgentHarnessSideQuestionParams,
  EmbeddedRunAttemptParams,
} from "./agent-harness-runtime.js";

export type {
  AgentHarnessApprovalAuthority,
  AgentHarnessBeforeToolCallApprovalRequest,
  AgentHarnessPluginApprovalRequest,
  AgentHarnessPluginApprovalResult,
} from "../agents/agent-harness-approval-authority.js";

/** Resolve approval authority from the exact host-admitted attempt object. */
export async function createApprovalAuthorityForAgentHarnessAttempt(
  attempt: EmbeddedRunAttemptParams,
): Promise<import("../agents/agent-harness-approval-authority.js").AgentHarnessApprovalAuthority> {
  const { createApprovalAuthorityForAgentHarnessAttempt: createCoreAuthority } =
    await import("../agents/agent-harness-approval-authority.js");
  return createCoreAuthority(attempt);
}

/** Resolve approval authority from the exact host-admitted side-question object. */
export async function createApprovalAuthorityForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
): Promise<import("../agents/agent-harness-approval-authority.js").AgentHarnessApprovalAuthority> {
  const { createApprovalAuthorityForAgentHarnessSideQuestion: createCoreAuthority } =
    await import("../agents/agent-harness-approval-authority.js");
  return createCoreAuthority(params);
}
