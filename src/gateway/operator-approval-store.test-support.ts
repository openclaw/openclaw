import type { NewOperatorApproval } from "./operator-approval-store.types.js";

export function createOperatorApproval(
  id: string,
  overrides: Partial<NewOperatorApproval> = {},
): NewOperatorApproval {
  const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
  return {
    id,
    kind,
    presentation:
      overrides.presentation ??
      (kind === "exec"
        ? createExecApprovalPresentation(`echo ${id}`)
        : {
            kind: "plugin",
            title: "Approve plugin action",
            description: `Allow the plugin action for ${id}.`,
            severity: "warning",
            pluginId: "test-plugin",
            toolName: "test-tool",
            agentId: "main",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          }),
    requester: {
      deviceId: "request-device",
      clientId: "request-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

export function createExecApprovalPresentation(
  commandText: string,
  allowedDecisions: Extract<
    NewOperatorApproval["presentation"],
    { kind: "exec" }
  >["allowedDecisions"] = ["allow-once", "allow-always", "deny"],
): Extract<NewOperatorApproval["presentation"], { kind: "exec" }> {
  return {
    kind: "exec",
    commandText,
    commandPreview: commandText,
    warningText: null,
    host: "gateway",
    nodeId: null,
    agentId: "main",
    allowedDecisions,
  };
}
