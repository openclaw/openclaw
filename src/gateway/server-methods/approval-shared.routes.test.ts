// Approval route selection and missing-route terminal behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));
const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));
vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: prepareApprovalChannelCustodyMock,
}));

function requestedEvent<TPayload>(record: ExecApprovalRecord<TPayload>) {
  return {
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

describe("approval request routing", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
    prepareApprovalChannelCustodyMock.mockReset();
  });

  it.for([
    {
      name: "reports an active approval client instead of the manual turn-source route",
      route: "client",
      id: "approval-with-client",
      request: { command: "echo ok", turnSourceChannel: "feishu", turnSourceAccountId: "work" },
    },
    {
      name: "counts an instance-local approval subscriber as a delivery route",
      route: "subscriber",
      id: "approval-internal-route",
      request: { command: "echo ok" },
    },
    {
      name: "checks plugin turn-source routes with plugin approval kind",
      route: "plugin",
      id: "plugin-turn-source-kind",
      request: {
        title: "Plugin approval",
        description: "Review the plugin action",
        turnSourceChannel: "whatsapp",
        turnSourceAccountId: "default",
      },
    },
    {
      name: "keeps register-only approval requests pending without a delivery route",
      route: "register-only",
      id: "approval-register-only",
      request: { command: "echo ok" },
    },
  ] as const)("$name", async ({ route, id, request }, testContext) => {
    if (route === "register-only") {
      hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    }
    const manager = createTestApprovalManager<typeof request>(testContext, {
      approvalKind: route === "plugin" ? "plugin" : "exec",
    });
    const record = manager.create(request, 60_000, id);
    await manager.register(record, 60_000);
    const responseSent = createDeferredCore();
    const respond = vi.fn(() => responseSent.resolve());
    const publishRequested = vi.fn(() => 1);
    const getApprovalClientConnIds = vi.fn(() => new Set<string>());
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => route === "client",
        ...(route === "subscriber"
          ? { approvalEvents: { publishRequested, publishResolved: vi.fn() } }
          : {}),
        ...(route === "plugin" ? { broadcastToConnIds: vi.fn(), getApprovalClientConnIds } : {}),
      } as unknown as GatewayRequestContext,
      requestEventName:
        route === "plugin" ? "plugin.approval.requested" : "exec.approval.requested",
      requestEvent: requestedEvent(record),
      twoPhase: true,
      approvalKind: route === "plugin" ? "plugin" : undefined,
      requireDeliveryRoute: route === "register-only" ? false : undefined,
      deliverRequest: () => false,
    });

    try {
      await Promise.race([responseSent.promise, requestPromise]);
      if (route === "client") {
        expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();
      } else if (route === "subscriber") {
        expect(publishRequested).toHaveBeenCalledWith(
          "exec",
          expect.objectContaining({ id: record.id }),
        );
      } else if (route === "plugin") {
        expect(getApprovalClientConnIds).toHaveBeenCalledWith(
          expect.objectContaining({ approvalKind: "plugin" }),
        );
        expect(hasApprovalTurnSourceRouteMock).toHaveBeenCalledWith({
          turnSourceChannel: "whatsapp",
          turnSourceAccountId: "default",
          approvalKind: "plugin",
          request: requestedEvent(record),
        });
      } else {
        expect((await manager.getSnapshot(record.id))?.resolvedAtMs).toBeUndefined();
      }
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          id,
          status: "accepted",
          ...(route === "register-only"
            ? {}
            : { deliveryRoute: route === "plugin" ? "turn-source" : "approval-client" }),
        }),
        undefined,
      );

      expect(await manager.resolve(record.id, "allow-once")).toBe(true);
      await requestPromise;
      if (route === "register-only") {
        expect((await manager.getSnapshot(record.id))?.resolvedBy).not.toBe("no-approval-route");
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({ id, decision: "allow-once" }),
          undefined,
        );
      }
    } finally {
      await manager.resolve(record.id, "deny");
      await Promise.allSettled([requestPromise, manager.drain()]);
    }
  });

  it("closes a plugin approval immediately when its exact Slack request has no route", async (testContext) => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
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
    const event = requestedEvent(record);

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
});
