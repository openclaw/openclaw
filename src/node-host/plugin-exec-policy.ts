import { getRuntimeConfig } from "../config/config.js";
import { assertCurrentUsageAuthorization } from "../infra/exec-approvals-authorization.kernel.js";
import {
  createExecApprovalPolicySnapshot,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveNodeExecConfigPolicy } from "./exec-policy.js";

/** Local policy stays on the executor; Gateway approval never overrides a local deny. */
export function preparePluginExecAuthorization(params: {
  source: Parameters<
    NonNullable<OpenClawPluginNodeHostCommandContext["prepareExecAuthorization"]>
  >[0];
  command: string;
  sessionKey?: string;
  assertActive: () => void;
  readCurrent: () => ExecApprovalsFile;
}): () => void {
  params.assertActive();
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const resolvePolicy = () =>
    resolveNodeExecConfigPolicy({
      cfg: getRuntimeConfig(),
      agentId,
    });
  const policy = resolvePolicy();
  const readCurrent = params.readCurrent;
  const approvals = readCurrent();
  const policySnapshot = createExecApprovalPolicySnapshot({ file: approvals, agentId });
  const assertCurrent = () => {
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
    // Committed in-process policy facts remain current through awaited plugin setup.
    assertCurrentUsageAuthorization({
      file: readCurrent(),
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
  assertCurrent();
  return assertCurrent;
}
