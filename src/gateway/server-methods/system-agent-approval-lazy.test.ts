import { expect, it, vi } from "vitest";
import type { SystemAgentApprovalRequest } from "../../infra/system-agent-approvals.js";

const { listApprovals } = vi.hoisted(() => ({
  listApprovals: vi.fn<() => Promise<SystemAgentApprovalRequest[]>>(),
}));

vi.mock("./approval-record-lookup.js", () => ({
  listVisiblePendingApprovalRequests: listApprovals,
}));

vi.mock("../../system-agent/config-redaction.js", () => {
  throw new Error("Approval listing must not load config redaction");
});

vi.mock("../../system-agent/chat-engine.js", () => {
  throw new Error("Approval listing must not load the system-agent chat engine");
});

it("lists approvals without loading chat or config redaction", async () => {
  const { coreGatewayHandlers } = await import("./core-handlers.js");
  const respond = vi.fn();
  const approval = {
    id: "pending-setup",
    request: {
      title: "Update the default model",
      description: "Select the synthetic model",
      command: "openclaw config set agents.defaults.model.primary openai/synthetic",
      proposalHash: "synthetic-proposal",
      allowedDecisions: ["allow-once", "deny"],
      sessionId: "setup",
    },
    createdAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  } satisfies SystemAgentApprovalRequest;
  listApprovals.mockResolvedValue([approval]);
  await coreGatewayHandlers["openclaw.approval.list"]!({
    req: { type: "req", id: "list", method: "openclaw.approval.list" },
    params: {},
    respond,
    context: { systemAgentApprovalManager: {} } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  expect(listApprovals).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(true, [approval], undefined);
});
