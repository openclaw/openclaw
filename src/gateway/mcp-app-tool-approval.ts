import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { McpAppViewLease } from "../agents/mcp-ui-resource.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../infra/exec-approval-text-sanitize.js";
import {
  truncatePluginApprovalDetail,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { handlePendingApprovalRequestWithDelivery } from "./server-methods/approval-request-delivery.js";
import { bindApprovalRequesterMetadata } from "./server-methods/approval-shared.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

/** A host-admitted App operation uses the same manager, reviewers, delivery and redemption as other plugin work. */
export async function requestMcpAppToolApproval(params: {
  options: GatewayRequestHandlerOptions;
  agentId: string;
  sessionKey: string;
  serverName: string;
  toolName: string;
  input: Record<string, unknown>;
  view?: McpAppViewLease;
  requesterId?: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { options, assertCurrent, view, requesterId } = params;
  assertCurrent();
  const grantKey = JSON.stringify([params.serverName, params.toolName]);
  if (view?.toolApprovalGrants?.get(requesterId)?.has(grantKey)) {
    return;
  }
  const manager = options.context.pluginApprovalManager;
  if (!manager) {
    throw new Error("MCP App approval service is unavailable");
  }
  const detail = truncatePluginApprovalDetail(
    sanitizeExecApprovalWarningText(
      JSON.stringify(
        { server: params.serverName, tool: params.toolName, arguments: params.input },
        null,
        2,
      ),
    ),
  );
  const timeoutMs = 120_000;
  const toolCallId = randomUUID();
  const payload: PluginApprovalRequestPayload = {
    pluginId: "bundle-mcp",
    title: truncateUtf16Safe(sanitizeExecApprovalDisplayText("Run " + params.toolName + "?"), 80),
    description: truncateUtf16Safe(
      sanitizeExecApprovalWarningText(
        "Allow this MCP App to call " +
          params.serverName +
          "/" +
          params.toolName +
          (view ? " once, or while this App stays open?" : " once?"),
      ),
      512,
    ),
    detail,
    severity: "warning",
    scope: null,
    toolName: sanitizeExecApprovalDisplayText(params.toolName),
    toolCallId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    runId: null,
    allowedDecisions: view ? ["allow-once", "allow-always", "deny"] : ["allow-once", "deny"],
    actions: [
      { kind: "decision", decision: "allow-once", label: "Allow once", command: "allow-once" },
      ...(view
        ? [
            {
              kind: "decision" as const,
              decision: "allow-always" as const,
              label: "Allow while this App is open",
              command: "allow-always",
            },
          ]
        : []),
      { kind: "decision", decision: "deny", label: "Deny", command: "deny" },
    ],
    turnSourceChannel: null,
    turnSourceTo: null,
    turnSourceAccountId: null,
    turnSourceThreadId: null,
  };
  const record = manager.create(payload, timeoutMs, "plugin:" + randomUUID());
  record.approvalAuthority = () => {
    assertCurrent();
    return true;
  };
  record.approvalSignals = [options.signal, params.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  bindApprovalRequesterMetadata({ record, client: options.client });
  const { decision } = await manager.register(record, timeoutMs);
  assertCurrent();
  await handlePendingApprovalRequestWithDelivery({
    approvalKind: "plugin",
    manager,
    record,
    respond: () => {},
    context: options.context,
    twoPhase: false,
    forwardRequest: options.context.forwardPluginApprovalRequest,
    getIosPushDelivery: () => options.context.pluginApprovalIosPushDelivery,
  });
  assertCurrent();
  const approved = manager.projectDecisionIfActive(record.id, await decision);
  if (approved !== "allow-once" && !(approved === "allow-always" && view)) {
    throw new Error("MCP App tool approval was denied, cancelled, or expired");
  }
  assertCurrent();
  if (
    approved === "allow-once" &&
    !(await manager.consumeAllowOnce(record.id, "mcp.app:" + toolCallId))
  ) {
    throw new Error("MCP App tool approval is no longer available");
  }
  assertCurrent();
  if (manager.projectDecisionIfActive(record.id, approved) !== approved) {
    throw new Error("MCP App tool approval authority changed");
  }
  if (approved === "allow-always" && view) {
    view.toolApprovalGrants ??= new Map();
    const grants = view.toolApprovalGrants.get(requesterId) ?? new Set<string>();
    grants.add(grantKey);
    view.toolApprovalGrants.set(requesterId, grants);
  }
}
