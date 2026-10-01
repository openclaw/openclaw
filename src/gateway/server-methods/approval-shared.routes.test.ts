// Plugin requests without a reviewer route must settle without running the action.
import { expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

it("closes a plugin approval immediately when its exact Slack request has no route", async (testContext) => {
  const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
  const record = manager.create(
    {
      title: "Review diffs",
      description: "Render a diff",
      turnSourceChannel: "slack",
      turnSourceAccountId: "default",
      policySubject: { pluginKey: "diffs", tool: "diffs" },
    },
    60_000,
    "plugin-slack-no-route",
  );
  await manager.register(record, 60_000);
  const respond = vi.fn();
  const event = {
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };

  await handlePendingApprovalRequest({
    manager,
    record,
    respond,
    context: {
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      getApprovalClientConnIds: () => new Set(),
    } as unknown as GatewayRequestContext,
    requestEventName: "plugin.approval.requested",
    requestEvent: event,
    twoPhase: true,
    approvalKind: "plugin",
    deliverRequest: () => false,
  });

  expect(hasApprovalTurnSourceRouteMock).toHaveBeenCalledWith({
    turnSourceChannel: "slack",
    turnSourceAccountId: "default",
    approvalKind: "plugin",
    request: event,
  });
  expect(await manager.getSnapshot(record.id)).toMatchObject({
    resolvedBy: "no-approval-route",
    terminalReason: "no-route",
  });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ id: record.id, decision: null }),
    undefined,
  );
});
