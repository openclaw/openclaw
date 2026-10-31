import { describe, expect, it, vi } from "vitest";
import {
  createApproverRestrictedNativeApprovalAdapter,
  createApproverRestrictedNativeApprovalCapability,
  createApproverRestrictedNativeApprovalCapabilityAsync,
  createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes,
  createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync,
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "./approval-delivery-helpers.js";
import { createNativeApprovalRuntimeStub as makeNativeRuntime } from "./test-helpers/native-approval.js";

const execRequest = {
  id: "approval-1",
  request: { command: "pwd" },
  createdAtMs: 0,
  expiresAtMs: 10_000,
};
const actionInput = { cfg: {}, accountId: "work", action: "approve" } as const;
const deliveryDefaults = {
  listAccountIds: () => ["work"],
  hasApprovers: () => true,
  isExecAuthorizedSender: () => true,
  isNativeDeliveryEnabled: () => true,
  resolveNativeDeliveryMode: () => "dm" as const,
};

describe("createApproverRestrictedNativeApprovalAdapter", () => {
  it("uses approver-restricted authorization for exec and plugin commands", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      ...deliveryDefaults,
      channel: "discord",
      channelLabel: "Discord",
      hasApprovers: ({ accountId }) => accountId === "work",
      isExecAuthorizedSender: ({ senderId }) => senderId === "exec-owner",
      isPluginAuthorizedSender: ({ senderId }) => senderId === "plugin-owner",
    });
    const authorizeActorAction = adapter.auth.authorizeActorAction;
    if (!authorizeActorAction) {
      throw new Error("approval auth unavailable");
    }

    const authorize = (
      senderId: string,
      approvalKind: "exec" | "plugin",
      request?: typeof execRequest,
    ) => authorizeActorAction({ ...actionInput, senderId, approvalKind, request });
    expect(authorize("exec-owner", "exec")).toEqual({ authorized: true });
    expect(authorize("plugin-owner", "plugin")).toEqual({ authorized: true });
    expect(authorize("someone-else", "plugin")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Discord.",
    });

    expect(
      authorize("plugin-owner", "plugin", { ...execRequest, id: "exec-request" }),
    ).toMatchObject({ authorized: false });
  });

  it("reports approval availability and DM routing from the relevant delivery surface", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      ...deliveryDefaults,
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => ["dm-only", "channel-only", "disabled", "no-approvers"],
      hasApprovers: ({ accountId }) => accountId !== "no-approvers",
      isNativeDeliveryEnabled: ({ accountId }) => accountId !== "disabled",
      resolveNativeDeliveryMode: ({ accountId }) =>
        accountId === "channel-only" ? "channel" : "dm",
      resolveOriginTarget: () => ({ to: "origin-chat" }),
      resolveApproverDmTargets: () => [{ to: "approver-1" }],
    });
    const { getActionAvailabilityState, getExecInitiatingSurfaceState } = adapter.auth;
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
      request: execRequest,
    });

    const availability = (accountId: string, approvalKind?: "plugin") =>
      getActionAvailabilityState({ ...actionInput, accountId, approvalKind });
    expect(availability("dm-only")).toEqual({ kind: "enabled" });
    expect(availability("no-approvers")).toEqual({ kind: "disabled" });
    expect(availability("disabled")).toEqual({ kind: "enabled" });
    expect(availability("disabled", "plugin")).toEqual({ kind: "enabled" });
    expect(getExecInitiatingSurfaceState({ ...actionInput, accountId: "disabled" })).toEqual({
      kind: "disabled",
    });
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
      ...deliveryDefaults,
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => [],
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

    const suppress = (
      turnSourceChannel: string,
      channel = "telegram",
      approvalKind: "exec" | "plugin" = "exec",
      turnSourceAccountId = "topic-1",
    ) =>
      shouldSuppressForwardingFallback({
        cfg: {},
        approvalKind,
        target: { channel, to: "target-1" },
        request: {
          ...execRequest,
          request: { command: "pwd", turnSourceChannel, turnSourceAccountId },
        },
      });
    expect(suppress("telegram", "telegram", "exec", " topic-1 ")).toBe(true);
    expect(suppress("slack")).toBe(false);
    expect(suppress("telegram", "slack")).toBe(false);

    expect(isNativeDeliveryEnabled).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "topic-1",
    });

    expect(suppress("telegram", "telegram", "plugin")).toBe(true);
  });
});

describe("createApproverRestrictedNativeApprovalCapability", () => {
  it("builds the canonical approval capability and preserves legacy split compatibility", () => {
    const nativeRuntime = makeNativeRuntime();
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
      ...deliveryDefaults,
      channel: "matrix",
      channelLabel: "Matrix",
      describeExecApprovalSetup,
      isExecAuthorizedSender: ({ senderId }) => senderId === "@owner:example.com",
      resolveApproverDmTargets: () => [{ to: "user:@owner:example.com" }],
    } satisfies Parameters<typeof createApproverRestrictedNativeApprovalCapability>[0];
    const capability = createApproverRestrictedNativeApprovalCapability({
      ...adapterParams,
      nativeRuntime,
    });
    const actorInput = {
      ...actionInput,
      senderId: "@owner:example.com",
      approvalKind: "exec",
    } as const;
    const deliveryInput = {
      cfg: {},
      accountId: "work",
      approvalKind: "exec",
      request: execRequest,
    } as const;
    const expectedCapabilities = {
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: false,
    };
    const setupInput = { channel: "matrix", channelLabel: "Matrix", accountId: "ops" };

    expect(capability.authorizeActorAction?.(actorInput)).toEqual({ authorized: true });
    expect(capability.delivery?.hasConfiguredDmRoute?.({ cfg: {} as never })).toBe(true);
    expect(capability.describeExecApprovalSetup?.(setupInput)).toBe("Matrix:matrix:ops:setup");
    expect(capability.describePluginApprovalSetup?.(setupInput)).toBeUndefined();
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

  it.each([
    {
      variant: "synchronous",
      create: createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes,
    },
    {
      variant: "asynchronous",
      create: createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync,
    },
  ])("assembles $variant forwarding routes with channel auth intact", async ({ create }) => {
    const authResult = { authorized: true } as const;
    const authorizeActorAction = vi.fn(() => authResult);
    const render = { exec: { buildPendingPayload: vi.fn() } };
    const routed = create({
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
      ...execRequest,
      request: {
        command: "pwd",
        turnSourceChannel: "example",
        turnSourceTo: "Origin",
      },
    } as never;
    const input = { cfg, accountId: "default", approvalKind: "exec", action: "approve" } as const;

    expect(routed.capability.authorizeActorAction?.({ ...input, senderId: "owner" })).toBe(
      authResult,
    );
    expect(routed.capability.render).toBe(render);
    expect(routed.capability.getActionAvailabilityState?.(input)).toEqual({ kind: "enabled" });
    expect(routed.capability.getExecInitiatingSurfaceState?.(input)).toEqual({ kind: "enabled" });
    expect(
      routed.capability.getActionAvailabilityState?.({ ...input, approvalKind: "plugin" }),
    ).toEqual({ kind: "disabled" });
    expect(routed.capability.delivery?.hasConfiguredDmRoute?.({ cfg })).toBe(true);
    const native = routed.capability.nativeAsync ?? routed.capability.native;
    expect(await native?.describeDeliveryCapabilities({ ...input, request })).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
    expect(await native?.resolveApproverDmTargets?.({ ...input, request })).toEqual([
      { to: "owner", accountId: "default" },
    ]);
    const suppress =
      routed.capability.delivery?.shouldSuppressForwardingFallbackAsync ??
      routed.capability.delivery?.shouldSuppressForwardingFallback;
    expect(
      await suppress?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "example", to: "ORIGIN", source: "target" },
        request,
      }),
    ).toBe(true);
    expect(
      await suppress?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "example", to: "unmatched", source: "target" },
        request,
      }),
    ).toBe(false);
    expect(routed.routing.isNativeApprovalHandlerConfigured({ cfg })).toBe(true);
  });

  it.each([
    {
      variant: "synchronous",
      create: createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes,
    },
    {
      variant: "asynchronous",
      create: createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync,
    },
  ])(
    "ignores only the named-account group isolation thread when matching $variant session targets",
    async ({ create }) => {
      const routed = create({
        channel: "example",
        channelLabel: "Example",
        authorizeActorAction: () => ({ authorized: true }),
        routing: {
          defaultForwardingMode: "session",
          isTransportEnabled: () => true,
          listAccountIds: () => ["work", "other"],
          resolveDefaultAccountId: () => "work",
          normalizeTo: (to) => to.trim().toLowerCase() || null,
          resolveApprovers: () => ["owner"],
        },
      });
      const cfg = { approvals: { exec: { enabled: true } } } as never;
      const request = {
        ...execRequest,
        request: {
          command: "pwd",
          turnSourceChannel: "example",
          turnSourceTo: "group-1",
          turnSourceAccountId: "work",
          turnSourceThreadId: "example-account-work",
        },
      } as never;
      const suppress =
        routed.capability.delivery?.shouldSuppressForwardingFallbackAsync ??
        routed.capability.delivery?.shouldSuppressForwardingFallback;
      const suppressFor = async (target: Record<string, string>) =>
        await suppress?.({
          cfg,
          approvalKind: "exec",
          target: {
            channel: "example",
            to: "group-1",
            accountId: "work",
            threadId: "example-account-work",
            source: "session",
            ...target,
          },
          request,
        });

      expect(await suppressFor({})).toBe(true);
      expect(await suppressFor({ threadId: "real-thread" })).toBe(false);
      expect(await suppressFor({ threadId: "example-account-other" })).toBe(false);
      expect(await suppressFor({ threadId: "other-channel-account-work" })).toBe(false);
      expect(await suppressFor({ accountId: "other", threadId: "example-account-other" })).toBe(
        false,
      );
      expect(await suppressFor({ source: "target" })).toBe(false);
    },
  );
});

describe("createChannelApprovalCapability", () => {
  it("accepts canonical top-level capability surfaces", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = makeNativeRuntime();
    const render = { exec: { buildPendingPayload: vi.fn() } };
    const native = { describeDeliveryCapabilities: vi.fn() };

    expect(createChannelApprovalCapability({ delivery, nativeRuntime, render, native })).toEqual({
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

describe("createApproverRestrictedNativeApprovalCapabilityAsync", () => {
  it("awaits channel actor authorization before allowing an approval action", async () => {
    const capability = createApproverRestrictedNativeApprovalCapabilityAsync({
      ...deliveryDefaults,
      channel: "example",
      channelLabel: "Example",
      listAccountIds: () => ["default"],
      isExecAuthorizedSender: async ({ senderId }) => senderId === "owner",
      isNativeDeliveryEnabled: async () => true,
    });
    const input = { cfg: {}, action: "approve", approvalKind: "exec" } as const;
    expect(await capability.authorizeActorActionAsync?.({ ...input, senderId: "other" })).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Example.",
    });
    expect(await capability.authorizeActorActionAsync?.({ ...input, senderId: "owner" })).toEqual({
      authorized: true,
    });
  });
});
