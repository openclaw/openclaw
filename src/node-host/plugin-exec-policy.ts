import { getRuntimeConfig } from "../config/config.js";
import { assertCurrentUsageAuthorization } from "../infra/exec-approvals-authorization.kernel.js";
import {
  prepareExecApprovalsCurrentRead,
  readExecApprovalsSnapshotAsync,
} from "../infra/exec-approvals-store.js";
import {
  createExecApprovalPolicySnapshot,
  loadExecApprovals,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveNodeExecConfigPolicy } from "./exec-policy.js";

type PluginExecAuthorizationParams = {
  source: Parameters<
    NonNullable<OpenClawPluginNodeHostCommandContext["prepareExecAuthorization"]>
  >[0];
  command: string;
  sessionKey?: string;
  assertActive: () => void;
};

/** @deprecated Await preparePluginExecAuthorizationAsync; removed in the next Plugin SDK major. */
export function preparePluginExecAuthorization(params: PluginExecAuthorizationParams): () => void {
  params.assertActive();
  const approvals = loadExecApprovals();
  const context = captureOpenClawStateWorkerContext();
  return retainPluginExecAuthorization(params, approvals, prepareExecApprovalsCurrentRead(context));
}

/** Local policy stays on the executor; Gateway approval never overrides a local deny. */
export async function preparePluginExecAuthorizationAsync(
  params: PluginExecAuthorizationParams,
): Promise<() => void> {
  params.assertActive();
  const context = captureOpenClawStateWorkerContext();
  // Only first use needs the writer to initialize a missing database.
  const { file } = context.admission.identity.key.startsWith("file:")
    ? await readExecApprovalsSnapshotAsync(context)
    : await runOpenClawStateWorkerOperation(
        context,
        () => readExecApprovalsSnapshotAsync(context),
        { assertCurrent: params.assertActive },
      );
  params.assertActive();
  return retainPluginExecAuthorization(params, file, prepareExecApprovalsCurrentRead(context));
}

function retainPluginExecAuthorization(
  params: PluginExecAuthorizationParams,
  approvals: ExecApprovalsFile,
  readCurrent: () => ExecApprovalsFile,
): () => void {
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const resolvePolicy = () =>
    resolveNodeExecConfigPolicy({
      cfg: getRuntimeConfig(),
      agentId,
    });
  const policy = resolvePolicy();
  const policySnapshot = createExecApprovalPolicySnapshot({ file: approvals, agentId });
  const assertPolicyCurrent = (file: ExecApprovalsFile) => {
    params.assertActive();
    const current = resolvePolicy();
    if (
      current.security === "deny" ||
      current.security !== policy.security ||
      current.ask !== policy.ask ||
      current.autoReview !== policy.autoReview ||
      (params.source === "session-full" && (current.security !== "full" || current.ask !== "off"))
    ) {
      throw new Error("SYSTEM_RUN_DENIED: node-local exec policy does not authorize this launch");
    }
    // The released synchronous launch guard must observe foreign policy commits.
    assertCurrentUsageAuthorization({
      file,
      agentId,
      command: params.command,
      matchKeys: new Set(),
      authorization: {
        source: params.source === "human-approved" ? "explicit-approval" : "current-policy",
        security: current.security,
        ask: current.ask,
        allowlistSatisfied: false,
        policySnapshot,
      },
    });
    params.assertActive();
  };
  assertPolicyCurrent(approvals);
  return () => {
    params.assertActive();
    assertPolicyCurrent(readCurrent());
  };
}
