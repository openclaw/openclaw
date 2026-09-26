/**
 * Tests approval delivery helper capability composition.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createApproverRestrictedNativeApprovalAdapter,
  createApproverRestrictedNativeApprovalCapability,
  createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes,
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "./approval-delivery-helpers.js";

describe("createApproverRestrictedNativeApprovalAdapter", () => {
  it("uses approver-restricted authorization for exec and plugin commands", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "discord",
      channelLabel: "Discord",
      listAccountIds: () => ["work"],
      hasApprovers: ({ accountId }) => accountId === "work",
      isExecAuthorizedSender: ({ senderId }) => senderId === "exec-owner",
      isPluginAuthorizedSender: ({ senderId }) => senderId === "plugin-owner",
      isNativeDeliveryEnabled: () => true,
      resolveNativeDeliveryMode: () => "dm",
    });
    const authorizeActorAction = adapter.auth.authorizeActorAction;
    if (!authorizeActorAction) {
      throw new Error("approval auth unavailable");
    }

    expect(
      authorizeActorAction({
        cfg: {} as never,
        accountId: "work",
        senderId: "exec-owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      authorizeActorAction({
        cfg: {} as never,
        accountId: "work",
        senderId: "plugin-owner",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      authorizeActorAction({
        cfg: {} as never,
        accountId: "work",
        senderId: "someone-else",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Discord.",
    });
  });

  it("reports approval availability and DM routing from the relevant delivery surface", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => ["dm-only", "channel-only", "disabled", "no-approvers"],
      hasApprovers: ({ accountId }) => accountId !== "no-approvers",
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled: ({ accountId }) => accountId !== "disabled",
      resolveNativeDeliveryMode: ({ accountId }) =>
        accountId === "channel-only" ? "channel" : "dm",
      resolveOriginTarget: () => ({ to: "origin-chat" }),
      resolveApproverDmTargets: () => [{ to: "approver-1" }],
    });
    const getActionAvailabilityState = adapter.auth.getActionAvailabilityState;
    const getExecInitiatingSurfaceState = adapter.auth.getExecInitiatingSurfaceState;
    const hasConfiguredDmRoute = adapter.delivery;
    if (
      !getActionAvailabilityState ||
      !getExecInitiatingSurfaceState ||
      !hasConfiguredDmRoute?.hasConfiguredDmRoute
    ) {
      throw new Error("approval availability helpers unavailable");
    }
    const nativeCapabilities = adapter.native?.describeDeliveryCapabilities({
      cfg: {} as never,
      accountId: "channel-only",
      approvalKind: "exec",
      request: {
        id: "approval-1",
        request: { command: "pwd" },
        createdAtMs: 0,
        expiresAtMs: 10_000,
      },
    });

    expect(
      getActionAvailabilityState({
        cfg: {} as never,
        accountId: "dm-only",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getActionAvailabilityState({
        cfg: {} as never,
        accountId: "no-approvers",
        action: "approve",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      getActionAvailabilityState({
        cfg: {} as never,
        accountId: "disabled",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getActionAvailabilityState({
        cfg: {} as never,
        accountId: "disabled",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getExecInitiatingSurfaceState({
        cfg: {} as never,
        accountId: "disabled",
        action: "approve",
      }),
    ).toEqual({ kind: "disabled" });
    expect(hasConfiguredDmRoute.hasConfiguredDmRoute({ cfg: {} as never })).toBe(true);
    expect(nativeCapabilities).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: false,
    });
  });

  it("suppresses forwarding fallback only for matching native-delivery surfaces", () => {
    const isNativeDeliveryEnabled = vi.fn(
      ({ accountId }: { accountId?: string | null }) => accountId === "topic-1",
    );
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => [],
      hasApprovers: () => true,
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled,
      resolveNativeDeliveryMode: () => "both",
      requireMatchingTurnSourceChannel: true,
      resolveSuppressionAccountId: ({ request }) =>
        request.request.turnSourceAccountId?.trim() || undefined,
    });
    const shouldSuppressForwardingFallback = adapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppressForwardingFallback) {
      throw new Error("delivery suppression helper unavailable");
    }

    expect(
      shouldSuppressForwardingFallback({
        cfg: {} as never,
        approvalKind: "exec",
        target: { channel: "telegram", to: "target-1" },
        request: {
          request: {
            command: "pwd",
            turnSourceChannel: "telegram",
            turnSourceAccountId: " topic-1 ",
          },
        } as never,
      }),
    ).toBe(true);

    expect(
      shouldSuppressForwardingFallback({
        cfg: {} as never,
        approvalKind: "exec",
        target: { channel: "telegram", to: "target-1" },
        request: {
          request: {
            command: "pwd",
            turnSourceChannel: "slack",
            turnSourceAccountId: "topic-1",
          },
        } as never,
      }),
    ).toBe(false);

    expect(
      shouldSuppressForwardingFallback({
        cfg: {} as never,
        approvalKind: "exec",
        target: { channel: "slack", to: "target-1" },
        request: {
          request: {
            command: "pwd",
            turnSourceChannel: "telegram",
            turnSourceAccountId: "topic-1",
          },
        } as never,
      }),
    ).toBe(false);

    expect(isNativeDeliveryEnabled).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "topic-1",
    });

    expect(
      shouldSuppressForwardingFallback({
        cfg: {} as never,
        approvalKind: "plugin",
        target: { channel: "telegram", to: "target-1" },
        request: {
          request: {
            command: "pwd",
            turnSourceChannel: "telegram",
            turnSourceAccountId: "topic-1",
          },
        } as never,
      }),
    ).toBe(true);
  });
});

describe("createApproverRestrictedNativeApprovalCapability", () => {
  it("builds the canonical approval capability and preserves legacy split compatibility", () => {
    const nativeRuntime = {
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload: vi.fn(),
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
    };
    const describeExecApprovalSetup = vi.fn(
      ({
        channel,
        channelLabel,
        accountId,
      }: {
        channel: string;
        channelLabel: string;
        accountId?: string;
      }) => `${channelLabel}:${channel}:${accountId ?? "default"}:setup`,
    );
    const adapterParams = {
      channel: "matrix",
      channelLabel: "Matrix",
      describeExecApprovalSetup,
      listAccountIds: () => ["work"],
      hasApprovers: () => true,
      isExecAuthorizedSender: ({ senderId }) => senderId === "@owner:example.com",
      isNativeDeliveryEnabled: () => true,
      resolveNativeDeliveryMode: () => "dm",
      resolveApproverDmTargets: () => [{ to: "user:@owner:example.com" }],
    } satisfies Parameters<typeof createApproverRestrictedNativeApprovalCapability>[0];
    const capability = createApproverRestrictedNativeApprovalCapability({
      ...adapterParams,
      nativeRuntime,
    });
    const actorInput = {
      cfg: {},
      accountId: "work",
      senderId: "@owner:example.com",
      action: "approve",
      approvalKind: "exec",
    } as const;
    const deliveryInput = {
      cfg: {},
      accountId: "work",
      approvalKind: "exec",
      request: {
        id: "approval-1",
        request: { command: "pwd" },
        createdAtMs: 0,
        expiresAtMs: 10_000,
      },
    } as const;
    const expectedCapabilities = {
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: false,
    };

    expect(capability.authorizeActorAction?.(actorInput)).toEqual({ authorized: true });
    expect(capability.delivery?.hasConfiguredDmRoute?.({ cfg: {} as never })).toBe(true);
    expect(
      capability.describeExecApprovalSetup?.({
        channel: "matrix",
        channelLabel: "Matrix",
        accountId: "ops",
      }),
    ).toBe("Matrix:matrix:ops:setup");
    expect(
      capability.describePluginApprovalSetup?.({
        channel: "matrix",
        channelLabel: "Matrix",
        accountId: "ops",
      }),
    ).toBeUndefined();
    expect(capability.native?.describeDeliveryCapabilities(deliveryInput)).toEqual(
      expectedCapabilities,
    );

    const split = splitChannelApprovalCapability(capability);
    const legacy = createApproverRestrictedNativeApprovalAdapter(adapterParams);
    for (const adapter of [split, legacy]) {
      expect(adapter.delivery?.hasConfiguredDmRoute?.({ cfg: {} })).toBe(true);
      expect(adapter.native?.describeDeliveryCapabilities(deliveryInput)).toEqual(
        expectedCapabilities,
      );
      expect(adapter.auth.authorizeActorAction?.(actorInput)).toEqual({ authorized: true });
      expect(adapter.auth.getExecInitiatingSurfaceState?.(actorInput)).toEqual({ kind: "enabled" });
      expect(adapter.describeExecApprovalSetup).toBe(describeExecApprovalSetup);
      expect(adapter.describePluginApprovalSetup).toBeUndefined();
    }
    expect(split.nativeRuntime).toBe(nativeRuntime);
  });

  it("assembles forwarding-routed capabilities without replacing channel auth results", () => {
    const authResult = { authorized: true } as const;
    const authorizeActorAction = vi.fn(() => authResult);
    const render = { exec: { buildPendingPayload: vi.fn() } };
    const routed = createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes({
      channel: "example",
      channelLabel: "Example",
      authorizeActorAction,
      routing: {
        defaultForwardingMode: "session",
        isTransportEnabled: () => true,
        listAccountIds: () => ["default"],
        resolveDefaultAccountId: () => "default",
        normalizeTo: (to) => to.trim().toLowerCase() || null,
        resolveApprovers: () => ["owner"],
      },
      render,
    });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "example", to: "Origin" }],
        },
      },
    } as never;
    const request = {
      id: "approval-1",
      request: {
        command: "pwd",
        turnSourceChannel: "example",
        turnSourceTo: "Origin",
      },
      createdAtMs: 0,
      expiresAtMs: 10_000,
    } as never;

    expect(
      routed.capability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toBe(authResult);
    expect(routed.capability.render).toBe(render);
    expect(
      routed.capability.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      routed.capability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
    expect(
      routed.capability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "example", to: "ORIGIN", source: "target" },
        request,
      }),
    ).toBe(true);
    expect(routed.routing.isNativeApprovalHandlerConfigured({ cfg })).toBe(true);
  });
});

describe("createChannelApprovalCapability", () => {
  it("accepts canonical top-level capability surfaces", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = {
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload: vi.fn(),
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
    };
    const render = {
      exec: {
        buildPendingPayload: vi.fn(),
      },
    };
    const native = { describeDeliveryCapabilities: vi.fn() };

    expect(
      createChannelApprovalCapability({
        delivery,
        nativeRuntime,
        render,
        native,
      }),
    ).toEqual({
      authorizeActorAction: undefined,
      getActionAvailabilityState: undefined,
      getExecInitiatingSurfaceState: undefined,
      resolveApproveCommandBehavior: undefined,
      describeExecApprovalSetup: undefined,
      describePluginApprovalSetup: undefined,
      delivery,
      nativeRuntime,
      render,
      native,
    });
  });
});
