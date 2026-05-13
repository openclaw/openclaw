import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  handleApprovalResolve,
  handlePendingApprovalRequest,
  isApprovalRecordVisibleToClient,
} from "./approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

type ApprovalClientLookup = NonNullable<GatewayRequestContext["getApprovalClientConnIds"]>;

function createApprovalClient(params: {
  connId: string;
  clientId: string;
  deviceId?: string;
  scopes?: string[];
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: params.clientId },
      device: params.deviceId ? { id: params.deviceId } : undefined,
      scopes: params.scopes ?? ["operator.approvals"],
    },
  } as GatewayClient;
}

function createApprovalClientLookup(clients: GatewayClient[]): ApprovalClientLookup {
  return (opts = {}) =>
    new Set(
      clients
        .filter((client) => {
          if (opts.excludeConnId && client.connId === opts.excludeConnId) {
            return false;
          }
          return opts.filter?.(client, opts.record) ?? true;
        })
        .map((client) => client.connId)
        .filter((connId): connId is string => typeof connId === "string" && connId.length > 0),
    );
}

describe("handlePendingApprovalRequest", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  it("allows operator.admin clients to see requester-bound approvals", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-admin-visible",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-admin",
          clientId: "client-admin",
          deviceId: "device-admin",
          scopes: ["operator.admin"],
        }),
      }),
    ).toBe(true);
  });

  it("allows approval-scoped clients to see no-device gateway-client approvals", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-client-visible",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(true);
  });

  it("does not widen non-gateway no-device approvals to every approval client", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-other-client-hidden",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
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
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
              deviceId: "device-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
              deviceId: "device-other",
            }),
          ]),
        ),
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

  it("targets no-device gateway-client approvals to approval-scoped clients", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-mobile",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-mobile-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-gateway",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
            }),
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected targeted approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-gateway",
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
      expect.objectContaining({ id: "approval-gateway-mobile" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("targets no-device approvals by client id after excluding the requester conn", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-no-device",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";
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
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-requester",
              clientId: "client-owner",
            }),
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
            }),
          ]),
        ),
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
      expect.objectContaining({ id: "approval-no-device" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("allows approval-scoped clients to resolve no-device gateway-client approvals", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-resolve",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-mobile-approval",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        scopes: ["operator.approvals"],
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot(record.id)?.decision).toBe("allow-once");
  });

  it("targets resolved approval events to visible approval clients when available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-resolved-visible",
    );
    record.requestedByDeviceId = "device-owner";
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
              deviceId: "device-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
              deviceId: "device-other",
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-owner-approval",
        clientId: "client-owner",
        deviceId: "device-owner",
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.resolved",
      expect.objectContaining({ id: "approval-resolved-visible" }),
      visibleConnIds,
      { dropIfSlow: true },
    );
  });
});
