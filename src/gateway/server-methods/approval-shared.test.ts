import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

describe("handlePendingApprovalRequest", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  it("does not resolve turn-source routes when approval clients are already available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
        turnSourceChannel: "feishu",
        turnSourceAccountId: "work",
      },
      60_000,
      "approval-with-client",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext,
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("targets requested approval events to visible approval clients when available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-visible",
    );
    record.requestedByDeviceId = "device-owner";
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(({ filter }) => {
          const ownerClient = {
            connId: "conn-owner-approval",
            connect: {
              client: { id: "client-owner" },
              device: { id: "device-owner" },
              scopes: ["operator.approvals"],
            },
          };
          const otherClient = {
            connId: "conn-other-approval",
            connect: {
              client: { id: "client-other" },
              device: { id: "device-other" },
              scopes: ["operator.approvals"],
            },
          };
          return new Set(
            [ownerClient, otherClient]
              .filter((client) => filter?.(client as never) ?? true)
              .map((client) => client.connId),
          );
        }),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected targeted approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-visible" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });
});
