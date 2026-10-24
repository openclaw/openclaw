/**
 * Tests shared approval helpers used by gateway method handlers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager, type ExecApprovalRecord } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import {
  createApprovalClient,
  createApprovalClientLookup,
} from "./approval-request.test-support.js";
import {
  bindApprovalReviewerDeviceIds,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalRecordVisibleToClient,
} from "./approval-shared.js";
import { handleApprovalResolve, requestedEvent } from "./approval.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));
const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

const owner = {
  requestedByDeviceId: "device-owner",
  requestedByConnId: "conn-owner",
  requestedByClientId: "client-owner",
};
const runtimeRequester = {
  requestedByDeviceId: "device-gateway-runtime",
  requestedByConnId: "conn-gateway-runtime",
  requestedByClientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
};
const cronRequest = {
  command: "echo cron",
  turnSourceChannel: "discord",
  turnSourceAccountId: "default",
};

async function createPendingFixture(
  test: TestContext,
  id: string,
  request: ExecApprovalRequestPayload = { command: "echo ok" },
  configure?: (record: ExecApprovalRecord) => void,
) {
  const manager = createTestApprovalManager(test);
  const record = manager.create(request, 60_000, id);
  configure?.(record);
  await manager.register(record, 60_000);
  const respond = vi.fn();
  return {
    manager,
    record,
    respond,
    pending: {
      manager,
      record,
      respond,
      requestEventName: "exec.approval.requested",
      requestEvent: requestedEvent(record),
      twoPhase: true,
    },
  };
}

function expectDecision(respond: ReturnType<typeof vi.fn>, id: string, decision: string | null) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ id, decision }), undefined);
}

function expectNoRoute(record: unknown) {
  expect(record).toMatchObject({ resolvedBy: "no-approval-route", terminalReason: "no-route" });
}

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

// mock-isolation: Approval fixtures control custody and config revocation without loading channel runtimes.
vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: (...args: unknown[]) => {
    const custody = prepareApprovalChannelCustodyMock(...args);
    return (
      custody && {
        ...custody,
        isCurrent:
          custody.isCurrent ??
          ((request: unknown) => {
            const input = args[0] as { cfg: unknown; getCfg?: () => unknown };
            return (!input.getCfg || input.getCfg() === input.cfg) && custody.authorizes(request);
          }),
        [Symbol.dispose]() {},
      }
    );
  },
}));

describe("handlePendingApprovalRequest", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
    prepareApprovalChannelCustodyMock.mockReset();
  });

  it.for([
    {
      name: "allows operator.admin clients to see requester-bound approvals",
      recordId: "approval-admin-visible",
      requestedBy: owner,
      client: {
        connId: "conn-admin",
        clientId: "client-admin",
        deviceId: "device-admin",
        scopes: ["operator.admin"],
      },
      expected: true,
    },
    {
      name: "does not trust gateway-client ids without the approval runtime marker",
      recordId: "approval-delivery-runtime-spoof-hidden",
      requestedBy: owner,
      client: {
        connId: "conn-spoofed-runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        scopes: ["operator.approvals"],
      },
      expected: false,
    },
  ])("$name", ({ recordId, requestedBy, client, expected }, testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, recordId);
    Object.assign(record, requestedBy);

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient(client),
      }),
    ).toBe(expected);
  });

  it("does not allow reviewer devices without approval scope to see approvals", (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      { command: "echo ok" },
      60_000,
      "approval-reviewer-device-scope-hidden",
    );
    Object.assign(record, runtimeRequester);
    bindApprovalReviewerDeviceIds({ record, deviceIds: ["device-mobile"] });

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-mobile",
          scopes: ["operator.read"],
        }),
      }),
    ).toBe(false);
  });

  it("does not widen explicitly reviewer-bound approvals to another device", (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      { command: "echo ok" },
      60_000,
      "approval-reviewer-device-isolated",
    );
    bindApprovalReviewerDeviceIds({ record, deviceIds: ["device-mobile"] });

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-other",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-other",
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
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

  it("targets requested approval events to visible approval clients when available", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-visible",
    );
    record.requestedByDeviceId = "device-owner";
    await manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
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
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: requestedEvent(record),
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

    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("routes backend-runtime approval events to the authorized approval reviewer device", async (testContext) => {
    const { manager, record, pending } = await createPendingFixture(
      testContext,
      "approval-reviewer-device-event",
      undefined,
      (pendingRecord) => {
        Object.assign(pendingRecord, runtimeRequester);
        bindApprovalReviewerDeviceIds({
          record: pendingRecord,
          deviceIds: [" device-mobile ", "device-mobile"],
        });
      },
    );
    expect(record.approvalReviewerDeviceIds).toEqual(["device-mobile"]);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-mobile-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      ...pending,
      context: {
        getRuntimeConfig: () => ({}),
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-mobile",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-gateway-runtime",
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-reviewer-device-event" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("targets requester-bound approval events to gateway-client approval runtimes", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-delivery-runtime",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    await manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-delivery-runtime"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-delivery-runtime",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              approvalRuntime: true,
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-owner",
      requestEventName: "exec.approval.requested",
      requestEvent: requestedEvent(record),
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-delivery-runtime" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("does not forward a request resolved during async native eligibility", async (testContext) => {
    const { manager, record, respond, pending } = await createPendingFixture(
      testContext,
      "approval-publication-race",
    );
    const publishing = createDeferredCore();
    const publication = createDeferredCore<number>();
    const publishRequested = vi.fn(() => 0);
    const deliverRequest = vi.fn(() => true);
    const requestPromise = handlePendingApprovalRequest({
      ...pending,
      context: {
        broadcast: vi.fn(),
        approvalEvents: {
          publishRequested,
          publishRequestedAsync: () => {
            publishing.resolve();
            return publication.promise;
          },
          publishResolved: vi.fn(),
        },
      } as unknown as GatewayRequestContext,
      deliverRequest,
    });
    await publishing.promise;
    await manager.resolve(record.id, "deny", "control-ui");
    publication.resolve(0);
    await requestPromise;
    expect(publishRequested).not.toHaveBeenCalled();
    expect(deliverRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ id: record.id, decision: "deny" }),
      undefined,
    );
  });

  it("returns a concurrent first answer when no-route denial loses after delivery", async (testContext) => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const { manager, record, respond, pending } = await createPendingFixture(
      testContext,
      "approval-no-route-race",
    );
    const { promise: delivery, resolve: finishDelivery } = createDeferredCore<boolean>();
    const requestPromise = handlePendingApprovalRequest({
      ...pending,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => false,
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      deliverRequest: () => delivery,
    });

    await Promise.resolve();
    expect(await manager.resolve(record.id, "allow-once", "control-ui")).toBe(true);
    finishDelivery(false);
    await requestPromise;

    expect(await manager.getSnapshot(record.id)).toMatchObject({
      decision: "allow-once",
      resolvedBy: "control-ui",
    });
    expect(respond).toHaveBeenCalledTimes(1);
    expectDecision(respond, record.id, "allow-once");
  });

  it("retains a concurrent approval binding through a delayed requester handoff", async (testContext) => {
    vi.useFakeTimers();
    try {
      const { manager, record, respond, pending } = await createPendingFixture(
        testContext,
        "approval-delayed-handoff",
      );
      const afterDecision = vi.fn();
      const { promise: delivery, resolve: finishDelivery } = createDeferredCore<boolean>();
      const requestPromise = handlePendingApprovalRequest({
        ...pending,
        context: {
          broadcast: vi.fn(),
          hasExecApprovalClients: () => false,
        } as unknown as GatewayRequestContext,
        deliverRequest: () => delivery,
        afterDecision,
      });

      await Promise.resolve();
      expect(await manager.resolve(record.id, "allow-once", "control-ui")).toBe(true);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(manager.getLiveSnapshot(record.id)).toMatchObject({
        decision: "allow-once",
        resolvedBy: "control-ui",
      });

      expect(afterDecision).not.toHaveBeenCalled();
      finishDelivery(true);
      await requestPromise;
      expect(afterDecision).toHaveBeenCalledWith(
        "allow-once",
        expect.objectContaining({ id: record.id }),
      );
      expect(respond).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({ id: record.id, decision: "allow-once" }),
        undefined,
      );
      expect(manager.getLiveSnapshot(record.id)).not.toBeNull();

      await vi.advanceTimersByTimeAsync(14_999);
      expect(manager.getLiveSnapshot(record.id)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getLiveSnapshot(record.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires suppressed requests instead of retaining a hidden turn-source route", async (testContext) => {
    const { manager, record, respond, pending } = await createPendingFixture(
      testContext,
      "approval-suppressed-turn-source",
      cronRequest,
    );
    const broadcast = vi.fn();
    const deliverRequest = vi.fn(() => true);

    await handlePendingApprovalRequest({
      ...pending,
      context: {
        broadcast,
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext,
      suppressDelivery: true,
      deliverRequest,
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(deliverRequest).not.toHaveBeenCalled();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();
    expectNoRoute(await manager.getSnapshot(record.id));
    expectDecision(respond, record.id, null);
  });

  it("keeps clients-only requests pending for approval clients without chat delivery", async (testContext) => {
    const { manager, record, respond, pending } = await createPendingFixture(
      testContext,
      "approval-clients-only-pending",
      cronRequest,
    );
    const broadcast = vi.fn();
    const deliverRequest = vi.fn(() => true);
    const publishRequested = vi.fn(() => 1);

    const requestPromise = handlePendingApprovalRequest({
      ...pending,
      context: {
        broadcast,
        hasExecApprovalClients: () => true,
        approvalEvents: { publishRequested, publishResolved: vi.fn() },
      } as unknown as GatewayRequestContext,
      deliverToApprovalClientsOnly: true,
      deliverRequest,
    });

    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: record.id }),
      expect.objectContaining({ dropIfSlow: true }),
    );
    expect(deliverRequest).not.toHaveBeenCalled();
    expect(publishRequested).not.toHaveBeenCalled();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();
    expect((await manager.getSnapshot(record.id))?.resolvedAtMs).toBeUndefined();

    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ id: record.id, decision: "allow-once" }),
      undefined,
    );
  });

  it("expires clients-only requests as no-route when no approval client is connected", async (testContext) => {
    const { manager, record, respond, pending } = await createPendingFixture(
      testContext,
      "approval-clients-only-no-route",
      cronRequest,
    );
    const afterDecision = vi.fn();
    const deliverRequest = vi.fn(() => true);
    const publishRequested = vi.fn(() => 1);

    await handlePendingApprovalRequest({
      ...pending,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => false,
        approvalEvents: { publishRequested, publishResolved: vi.fn() },
      } as unknown as GatewayRequestContext,
      deliverToApprovalClientsOnly: true,
      deliverRequest,
      afterDecision,
    });

    expect(afterDecision).not.toHaveBeenCalled();
    expect(deliverRequest).not.toHaveBeenCalled();
    expect(publishRequested).not.toHaveBeenCalled();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();
    expectNoRoute(await manager.getSnapshot(record.id));
    expectDecision(respond, record.id, null);
  });

  it("does not target no-device approvals by self-declared client id", async (testContext) => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-no-device",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";
    await manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set<string>();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
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
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: requestedEvent(record),
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
    await requestPromise;
    expect((await manager.getSnapshot(record.id))?.resolvedBy).toBe("no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-no-device", decision: null }),
      undefined,
    );
  });

  it("does not resolve no-device approvals by self-declared client id", async (testContext) => {
    const { manager, record, respond } = await createPendingFixture(
      testContext,
      "approval-no-device-resolve",
      undefined,
      (pendingRecord) => {
        pendingRecord.requestedByConnId = "conn-requester";
        pendingRecord.requestedByClientId = "client-owner";
      },
    );

    await handleApprovalResolve({
      approvalKind: "exec",
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-other",
        clientId: "client-owner",
        scopes: ["operator.approvals"],
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect((await manager.getSnapshot(record.id))?.decision).toBeUndefined();
  });

  it("does not wait on decisions for approvals hidden from the caller", async (testContext) => {
    const { manager, record, respond } = await createPendingFixture(
      testContext,
      "approval-wait-hidden",
      undefined,
      (pendingRecord) => Object.assign(pendingRecord, owner),
    );
    expect(await manager.resolve(record.id, "allow-once")).toBe(true);

    await handleApprovalWaitDecision({
      manager,
      inputId: record.id,
      respond,
      client: createApprovalClient({
        connId: "conn-other",
        clientId: "client-other",
        deviceId: "device-other",
        scopes: ["operator.approvals"],
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "approval expired or not found",
      }),
    );
  });

  it("releases run-aborted waiters without changing timeout terminal state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-wait-terminal-"));
    const manager = new ExecApprovalManager({
      scheduler: createTestGatewayScheduler(),
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-wait-terminal",
        databaseOptions: { path: path.join(tempDir, "state.sqlite") },
      },
    });
    async function register(command: string, runId: string, id: string) {
      const record = manager.create({ command, runId }, 60_000, id);
      Object.assign(record, owner);
      await manager.register(record, 60_000);
      return record;
    }
    const wait = (
      record: ExecApprovalRecord,
      respond: Parameters<typeof handleApprovalWaitDecision>[0]["respond"],
      resolveTerminalReason?: () => "run-aborted",
    ) =>
      handleApprovalWaitDecision({
        manager,
        inputId: record.id,
        respond,
        resolveTerminalReason,
        client: createApprovalClient({
          connId: "conn-owner-approval",
          clientId: "client-owner",
          deviceId: "device-owner",
          scopes: ["operator.approvals"],
        }),
      });
    const expectTerminal = (
      respond: ReturnType<typeof vi.fn>,
      record: ExecApprovalRecord,
      decision: string | null,
      terminalReason: string,
    ) => {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ id: record.id, decision, terminalReason }),
        undefined,
      );
    };
    const record = await register("echo ok", "run-aborted", "approval-wait-run-aborted");
    const respond = vi.fn();
    const waiting = wait(record, respond);
    expect(
      await manager.forceDenyDetailed(
        record.id,
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "denied" });
    await waiting;

    expectTerminal(respond, record, null, "run-aborted");

    const timeoutRecord = await register("echo later", "run-timeout", "approval-wait-timeout");
    const timeoutRespond = vi.fn();
    const timeoutWaiting = wait(timeoutRecord, timeoutRespond);
    expect(await manager.expire(timeoutRecord.id)).toBe(true);
    await timeoutWaiting;
    expectTerminal(timeoutRespond, timeoutRecord, null, "timeout");

    const allowedRecord = await register(
      "echo allowed",
      "run-allowed-before-abort",
      "approval-wait-allowed-before-abort",
    );
    expect(await manager.resolve(allowedRecord.id, "allow-once")).toBe(true);
    const allowedRespond = vi.fn();
    await wait(allowedRecord, allowedRespond, () => "run-aborted");
    expectTerminal(allowedRespond, allowedRecord, "allow-once", "run-aborted");
    await manager.drain();
    await closeOpenClawStateDatabaseByPathAsync(path.join(tempDir, "state.sqlite"));
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("does not allow approval-scoped clients to resolve device-bound gateway-client approvals from another device", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-device-resolve",
    );
    record.requestedByDeviceId = "device-gateway";
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    await manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      approvalKind: "exec",
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-mobile",
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-mobile-approval",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        deviceId: "device-mobile",
        scopes: ["operator.approvals"],
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect((await manager.getSnapshot(record.id))?.decision).toBeUndefined();
  });

  it("allows gateway-client approval runtimes to resolve requester-bound approvals", async (testContext) => {
    const { manager, record, respond } = await createPendingFixture(
      testContext,
      "approval-delivery-runtime-resolve",
      undefined,
      (pendingRecord) => Object.assign(pendingRecord, owner),
    );
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      approvalKind: "exec",
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-delivery-runtime",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              scopes: ["operator.approvals"],
              approvalRuntime: true,
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-delivery-runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      }),
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect((await manager.getSnapshot(record.id))?.decision).toBe("allow-once");
  });

  it("filters legacy prefix candidates by channel custody before resolving", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const owned = manager.create({ command: "owned" }, 60_000, "approval-prefix-owned");
    const foreign = manager.create({ command: "foreign" }, 60_000, "approval-prefix-foreign");
    const cfg = {};
    await manager.register(owned, 60_000);
    await manager.register(foreign, 60_000);
    prepareApprovalChannelCustodyMock.mockReturnValue({
      resolverId: "telegram:ops",
      authorizes: (request: { request: { command: string } }) =>
        request.request.command === "owned",
    });
    const respond = vi.fn();

    await handleApprovalResolve({
      approvalKind: "exec",
      manager,
      inputId: "approval-prefix",
      decision: "deny",
      reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
      respond,
      context: {
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        getRuntimeConfig: () => cfg,
      } as unknown as GatewayRequestContext,
      client: null,
      exposeAmbiguousPrefixError: true,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect((await manager.getSnapshot(owned.id))?.decision).toBe("deny");
    expect((await manager.getSnapshot(foreign.id))?.decision).toBeUndefined();
  });

  it("targets resolved approval events to visible approval clients when available", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-resolved-visible",
    );
    record.requestedByDeviceId = "device-owner";
    await manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);

    await handleApprovalResolve({
      approvalKind: "exec",
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        getRuntimeConfig: () => ({}),
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
    expectNoRoute(await manager.getSnapshot(record.id));
    expectDecision(respond, record.id, null);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
