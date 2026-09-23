import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { SUBAGENT_EXEC_ENV_VAR } from "../infra/openclaw-exec-env.js";

/** Operator message RPCs cannot preserve the source of an agent's shell report. */
export function assertGatewayCliMessageContext(method: string, params?: unknown): void {
  const agentExec = process.env.OPENCLAW_SHELL === "exec";
  const subagentExec = process.env[SUBAGENT_EXEC_ENV_VAR] === "1";
  if (!agentExec && !subagentExec) {
    return;
  }
  const sessionMessage = ["sessions.send", "sessions.steer", "chat.send"].includes(method);
  if (subagentExec && sessionMessage) {
    throw new Error(
      "Subagent session messages must use the task completion path. Return your result or blocker in the child turn; do not use the CLI to contact other sessions.",
    );
  }
  if (!agentExec) {
    return;
  }
  const input = method === "sessions.create" ? asNullableRecord(params) : null;
  const createsInitialTurn =
    input &&
    ([input.message, input.task].some((value) => typeof value === "string" && value.trim()) ||
      (Array.isArray(input.attachments) && input.attachments.length > 0));
  if (createsInitialTurn || sessionMessage || method === "agent") {
    // This inherited marker only refuses accidental operator re-entry. It is not
    // authentication, and must never mint provenance or grant a missing tool.
    throw new Error(
      `Gateway ${method} from agent exec would lose inter-session attribution. ` +
        "Use the attributed session-messaging tool available to this run, or return the result " +
        "through normal subagent completion. Do not retry through another CLI route or remove the exec marker.",
    );
  }
}
