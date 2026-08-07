import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { GatewayClient } from "./types.js";

/** Binds only Gateway-verified execution identity at the approval creation boundary. */
export function bindApprovalExecutionIdentity<TPayload>(params: {
  cfg: OpenClawConfig;
  client?: GatewayClient | null;
  record: ExecApprovalRecord<TPayload>;
}): void {
  params.record.sourceRuntimeIdentity = undefined;
  const runtimeIdentity = params.client?.internal?.agentRuntimeIdentity;
  const raw = runtimeIdentity?.executionIdentity;
  if (!raw || !isExecutionIdentityCollectionEnabled(params.cfg)) {
    return;
  }
  try {
    const identity = parseExecutionIdentityAdmissionToken(raw);
    const requestRunId = normalizeOptionalString(
      typeof params.record.request === "object" && params.record.request !== null
        ? (params.record.request as Record<string, unknown>).runId
        : undefined,
    );
    // Bind only when the approval's effective source run agrees with the verified token.
    // A mismatch is non-authoritative; neither correlation may override the other.
    if (!requestRunId || requestRunId === identity.runId) {
      params.record.sourceRuntimeIdentity = {
        agentId: runtimeIdentity.agentId,
        sessionKey: runtimeIdentity.sessionKey,
        executionIdentity: identity,
      };
    }
  } catch {
    // Invalid synthetic client state is never authoritative.
  }
}
