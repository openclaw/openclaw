import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { lookupCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { sanitizeExecApprovalDisplayTextWithStatus } from "../../infra/exec-approval-text-sanitize.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import { createAgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { WorkerEnvironmentAttachment } from "../worker-environments/session-attachment.js";
import { bindApprovalRequesterMetadata } from "./approval-shared.js";
import { handlePendingExecApprovalRequest } from "./exec-approval-request-delivery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Reuses operator approval custody; a decision authorizes this exact admitted invocation only. */
export async function approveSessionEnvironmentCommand(params: {
  options: GatewayRequestHandlerOptions;
  binding: WorkerEnvironmentAttachment;
  argv: readonly string[];
  background: boolean;
  input?: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { options, binding, assertCurrent } = params;
  const manager = options.context.execApprovalManager;
  if (!manager) {
    throw new Error("Execution approval service is unavailable");
  }
  assertCurrent();
  const ambient = options.client?.internal?.syntheticClient
    ? getGatewayToolCallerIdentity()
    : undefined;
  const runtime =
    options.client?.internal?.agentRuntimeIdentity ??
    (ambient?.operationalRunInstance
      ? await createAgentRuntimeIdentity({
          ...ambient,
          operationalRunInstance: ambient.operationalRunInstance,
        })
      : undefined);
  assertCurrent();
  if (ambient && !runtime) {
    throw new Error("Environment command approval requires the current admitted run");
  }
  const command = sanitizeExecApprovalDisplayTextWithStatus(
    JSON.stringify({
      argv: params.argv,
      ...(params.input === undefined ? {} : { stdin: params.input }),
    }),
  );
  if (command.truncated || command.oversized) {
    throw new Error(
      "Environment command is too large to review completely; split it into smaller commands",
    );
  }
  const record = manager.create(
    {
      command: command.text,
      host: "worker",
      ...binding,
      runId: runtime?.operationalRunInstance.runId,
      allowedDecisions: ["allow-once", "deny"],
      warningText: `${params.background ? "Start a background process" : "Run a command"} in attached environment ${binding.environmentId}.${params.input === undefined ? "" : ` The command receives ${Buffer.byteLength(params.input)} bytes on stdin.`} Approval is limited to this environment and invocation.`,
      turnSourceChannel: runtime?.turnSourceChannel,
      turnSourceTo: runtime?.turnSourceTo,
      turnSourceAccountId: runtime?.turnSourceAccountId,
      turnSourceThreadId: runtime?.turnSourceThreadId,
    },
    DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  );
  bindApprovalRequesterMetadata({ record, client: options.client });
  record.approvalAuthority = assertCurrent;
  record.approvalSignals = params.signal ? [params.signal] : [];
  if (runtime) {
    record.agentRuntimeDelegatedAuthority = runtime.delegatedAuthority;
  }
  if (runtime?.executionIdentity) {
    record.executionIdentityToken = runtime.executionIdentity;
  }
  const decision = manager.register(record, DEFAULT_EXEC_APPROVAL_TIMEOUT_MS);
  void decision.catch(() => undefined);
  let approved = false;
  await handlePendingExecApprovalRequest({
    manager,
    record,
    context: options.context,
    clientConnId: options.client?.connId,
    twoPhase: false,
    deliverToApprovalClientsOnly:
      lookupCronRunExecSource(runtime?.operationalRunInstance.runId)?.agentId === binding.agentId,
    forwardRequest: options.context.forwardExecApprovalRequest,
    getIosPushDelivery: () => options.context.execApprovalIosPushDelivery,
    respond: (ok, _payload, error) => {
      if (!ok) {
        throw new Error(error?.message ?? "Execution approval failed");
      }
    },
    afterDecision: (resolved) => {
      assertCurrent();
      approved = resolved === "allow-once" && manager.consumeAllowOnce(record.id);
    },
    afterDecisionErrorLabel: "environment exec approvals: approval follow-up failed",
  });
  assertCurrent();
  if (!approved) {
    throw new Error("Environment command was not approved");
  }
}
