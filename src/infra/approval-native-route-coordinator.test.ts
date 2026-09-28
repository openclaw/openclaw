// Covers native approval route reporting behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter as createApprovalNativeRouteReporterRaw,
} from "./approval-native-route-coordinator.js";
import type { ApprovalRouteSendParams } from "./approval-native-route-notice.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const approvalRouteReporters: Array<ReturnType<typeof createApprovalNativeRouteReporterRaw>> = [];
const defaultRouteSelector = {
  shouldHandle: () => true,
  classifyRoute: () => "unbound" as const,
};

type ReporterOptions = Parameters<typeof createApprovalNativeRouteReporterRaw>[0];

function reporterOptions(overrides: Partial<ReporterOptions> = {}): ReporterOptions {
  return {
    ...defaultRouteSelector,
    handledKinds: new Set(["exec"]),
    channel: "telegram",
    accountId: "default",
    requestGateway: createGatewayRequestMock(),
    ...overrides,
  };
}

function createApprovalNativeRouteReporter(params: Partial<ReporterOptions>) {
  const reporter = createApprovalNativeRouteReporterRaw(reporterOptions(params));
  approvalRouteReporters.push(reporter);
  return reporter;
}

function createRequest(
  id: string,
  request: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id,
    request: { command: "echo hi", ...request },
    createdAtMs: 0,
    expiresAtMs: Date.now() + 60_000,
  };
}

function createPluginRequest(id: string): PluginApprovalRequest {
  return {
    approvalKind: "plugin",
    id,
    request: {
      title: "Run report",
      description: "Render a diff",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "1712345678.123456",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

function captureHostPluginOrigin(params: {
  coordinator: ReturnType<typeof createApprovalNativeRouteCoordinator>;
  request: PluginApprovalRequest;
  requestGateway: ReturnType<typeof createGatewayRequestMock>;
  isOriginCurrent?: (cfg?: OpenClawConfig) => boolean;
}) {
  params.request.request.approvalSource = {
    channel: params.request.request.turnSourceChannel ?? "slack",
    senderId: "requester",
  };
  params.coordinator.capturePluginOrigin(params.request, undefined, {
    requestGateway: params.requestGateway,
    isOriginCurrent: (_request, cfg) => params.isOriginCurrent?.(cfg) ?? true,
  });
}

afterEach(async () => {
  await Promise.all(approvalRouteReporters.splice(0).map((reporter) => reporter.stop()));
  vi.useRealTimers();
});

function createGatewayRequestMock() {
  return vi.fn(
    async (
      _method: "send",
      _params: ApprovalRouteSendParams,
      _options?: { liveOnlyWhenCurrent: (cfg?: OpenClawConfig) => boolean },
    ): Promise<void> => {},
  );
}

function approverDm(to: string) {
  return { surface: "approver-dm" as const, target: { to }, reason: "preferred" as const };
}

describe("plugin approval requester outcome", () => {
  it.each([
    {
      channel: "slack",
      label: "Slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "1712345678.123456",
      status: "denied",
      wording: "was denied",
    },
    {
      channel: "slack",
      label: "Slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "1712345678.123456",
      status: "expired",
      wording: "timed out",
    },
    {
      channel: "telegram",
      label: "Telegram",
      to: "-100123",
      accountId: "default",
      threadId: undefined,
      status: "denied",
      wording: "was denied",
    },
  ] as const)("reports a $status $channel DM-only approval to its exact origin", async (route) => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const reporter = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: route.channel,
        channelLabel: route.label,
        accountId: route.accountId,
        requestGateway,
      }),
    );
    const baseRequest = createPluginRequest(`plugin:${route.channel}-${route.status}`);
    const request: PluginApprovalRequest = {
      ...baseRequest,
      request: {
        ...baseRequest.request,
        turnSourceChannel: route.channel,
        turnSourceTo: route.to,
        turnSourceAccountId: route.accountId,
        turnSourceThreadId: route.threadId,
      },
    };
    const reviewerTarget = approverDm(route.channel === "telegram" ? "456" : "user:reviewer");
    reporter.start();
    captureHostPluginOrigin({ coordinator, request, requestGateway });
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [reviewerTarget],
        originTarget: { to: route.to, threadId: route.threadId },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [reviewerTarget],
    });
    expect(requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent()).toBe(true);
    // The channel's own card expiry/settlement must not retire the Gateway outcome route.
    reporter.completeRequest(request.id);
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: route.status });
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: route.status });

    expect(requestGateway).toHaveBeenCalledTimes(2);
    expect(requestGateway).toHaveBeenNthCalledWith(
      1,
      "send",
      {
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
        message: `Approval ${request.id} required. I sent the approval request to ${route.label} DMs, not this chat.`,
        idempotencyKey: `approval-route-notice:${request.id}`,
      },
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    expect(requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent()).toBe(false);
    expect(requestGateway).toHaveBeenLastCalledWith(
      "send",
      {
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
        message: `Approval ${request.id} ${route.wording}. The requested action did not run.`,
        idempotencyKey: `approval-terminal-notice:${request.id}`,
      },
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    const terminalCurrent = requestGateway.mock.calls[1]?.[2]?.liveOnlyWhenCurrent;
    expect(terminalCurrent?.()).toBe(true);
    await reporter.stop();
    expect(terminalCurrent?.()).toBe(false);
    coordinator.close();
  });

  it("waits for the actual DM delivery report when the Gateway resolves first", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const reporter = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        channelLabel: "Slack",
        accountId: "work",
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:early-deny");
    reporter.start();
    captureHostPluginOrigin({ coordinator, request, requestGateway });
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    reporter.completeRequest(request.id);
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [approverDm("user:reviewer")],
        originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [approverDm("user:reviewer")],
    });

    expect(requestGateway.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      `approval-terminal-notice:${request.id}`,
    ]);
    coordinator.close();
  });

  it("invalidates an in-flight fallback notice when a plugin approval is denied", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    let originCurrent = true;
    const reporter = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        channelLabel: "Slack",
        accountId: "work",
        isOriginCurrent: () => originCurrent,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:fallback-denied");
    reporter.start();
    captureHostPluginOrigin({ coordinator, request, requestGateway });
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [approverDm("user:reviewer")],
        originTarget: { to: "channel:C123" },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [],
    });

    const currentAtHandoff = requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
    expect(currentAtHandoff).toBeTypeOf("function");
    expect(currentAtHandoff?.()).toBe(true);
    originCurrent = false;
    expect(currentAtHandoff?.()).toBe(false);
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    expect(currentAtHandoff?.()).toBe(false);
    coordinator.close();
  });

  it("keeps a cross-channel plugin notice on its original config snapshot", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const sourceConfig = {};
    const reporter = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "telegram",
        channelLabel: "Telegram",
        sourceConfig,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:cross-channel");
    reporter.start();
    captureHostPluginOrigin({
      coordinator,
      request,
      requestGateway,
      isOriginCurrent: (cfg) => cfg === undefined || cfg === sourceConfig,
    });
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [approverDm("user:reviewer")],
        originTarget: null,
        notifyOriginWhenDmOnly: false,
      },
      deliveredTargets: [approverDm("user:reviewer")],
    });

    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        channel: "slack",
        accountId: "work",
        message: `Approval ${request.id} required. I sent the approval request to Telegram DMs, not this chat.`,
      }),
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    const currentAtHandoff = requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
    expect(currentAtHandoff?.(sourceConfig)).toBe(true);
    expect(currentAtHandoff?.({})).toBe(false);
    coordinator.close();
  });

  it.each(["allowed", "cancelled"] as const)(
    "does not tell the requester a %s approval is pending after another runtime completes",
    async (status) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const reporter = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          channelLabel: "Slack",
          accountId: "work",
          requestGateway,
          classifyRoute: () => "bound-or-explicit",
        }),
      );
      const forwarded = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          channelLabel: "Slack",
          accountId: "other",
          requestGateway,
          classifyRoute: () => "bound-or-explicit",
        }),
      );
      const request = createPluginRequest(`plugin:early-${status}`);
      reporter.start();
      forwarded.start();
      captureHostPluginOrigin({ coordinator, request, requestGateway });
      reporter.selectRequest({ approvalKind: "plugin", request });
      forwarded.selectRequest({ approvalKind: "plugin", request });
      await coordinator.finishPluginOriginRouting(request.id, true);
      await forwarded.reportDelivery({
        approvalKind: "plugin",
        request,
        deliveryPlan: {
          targets: [approverDm("user:reviewer")],
          originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
          notifyOriginWhenDmOnly: true,
        },
        deliveredTargets: [approverDm("user:reviewer")],
      });
      await coordinator.publishPluginTerminal({ approvalId: request.id, status });
      forwarded.completeRequest(request.id);
      await forwarded.stop();
      await reporter.reportDelivery({
        approvalKind: "plugin",
        request,
        deliveryPlan: {
          targets: [approverDm("user:reviewer")],
          originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
          notifyOriginWhenDmOnly: true,
        },
        deliveredTargets: [approverDm("user:reviewer")],
      });

      expect(requestGateway).not.toHaveBeenCalled();
      coordinator.close();
    },
  );

  it.each(["allowed", "cancelled"] as const)(
    "does not send a queued pending notice after the approval is %s",
    async (status) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const reporter = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          channelLabel: "Slack",
          accountId: "work",
          requestGateway,
        }),
      );
      const request = createPluginRequest(`plugin:queued-${status}`);
      reporter.start();
      captureHostPluginOrigin({ coordinator, request, requestGateway });
      reporter.selectRequest({ approvalKind: "plugin", request });
      await coordinator.finishPluginOriginRouting(request.id, true);
      const delivery = reporter.reportDelivery({
        approvalKind: "plugin",
        request,
        deliveryPlan: {
          targets: [approverDm("user:reviewer")],
          originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
          notifyOriginWhenDmOnly: true,
        },
        deliveredTargets: [approverDm("user:reviewer")],
      });
      await coordinator.publishPluginTerminal({ approvalId: request.id, status });
      await delivery;

      expect(requestGateway).not.toHaveBeenCalled();
      coordinator.close();
    },
  );

  it.each(["allowed", "cancelled"] as const)(
    "does not revive a %s plugin request when delivery finishes after expiry",
    async (status) => {
      vi.useFakeTimers();
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const reporter = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          accountId: "work",
          requestGateway,
        }),
      );
      const request = createPluginRequest(`plugin:late-${status}`);
      request.expiresAtMs = Date.now() + 100;
      reporter.start();
      captureHostPluginOrigin({ coordinator, request, requestGateway });
      reporter.selectRequest({ approvalKind: "plugin", request });
      await coordinator.finishPluginOriginRouting(request.id, true);
      await coordinator.publishPluginTerminal({ approvalId: request.id, status });
      await vi.advanceTimersByTimeAsync(101);
      await reporter.reportDelivery({
        approvalKind: "plugin",
        request,
        deliveryPlan: {
          targets: [approverDm("user:reviewer")],
          originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
          notifyOriginWhenDmOnly: true,
        },
        deliveredTargets: [approverDm("user:reviewer")],
      });

      expect(requestGateway).not.toHaveBeenCalled();
      coordinator.close();
    },
  );

  it("keeps a late DM route for the Gateway timeout without sending a stale pending notice", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const reporter = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        channelLabel: "Slack",
        accountId: "work",
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:late-timeout");
    request.expiresAtMs = Date.now() + 100;
    reporter.start();
    captureHostPluginOrigin({ coordinator, request, requestGateway });
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    await vi.advanceTimersByTimeAsync(101);
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [approverDm("user:reviewer")],
        originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [approverDm("user:reviewer")],
    });
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "expired" });

    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        idempotencyKey: `approval-terminal-notice:${request.id}`,
        message: `Approval ${request.id} timed out. The requested action did not run.`,
      }),
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    coordinator.close();
  });

  it.each(["origin-card", "forwarded-only", "dm-without-origin-notice"] as const)(
    "does not duplicate the %s outcome in the origin",
    async (route) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const reporter = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          channelLabel: "Slack",
          accountId: "work",
          requestGateway,
        }),
      );
      const request = createPluginRequest(`plugin:${route}`);
      const deliveredTargets =
        route === "origin-card"
          ? [
              {
                surface: "origin" as const,
                target: { to: "channel:C123", threadId: "1712345678.123456" },
                reason: "preferred" as const,
              },
            ]
          : route === "dm-without-origin-notice"
            ? [approverDm("user:reviewer")]
            : [];
      reporter.start();
      captureHostPluginOrigin({ coordinator, request, requestGateway });
      reporter.selectRequest({ approvalKind: "plugin", request });
      await coordinator.finishPluginOriginRouting(request.id, true);
      await reporter.reportDelivery({
        approvalKind: "plugin",
        request,
        deliveryPlan: {
          targets: deliveredTargets,
          originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
          notifyOriginWhenDmOnly: route !== "dm-without-origin-notice",
        },
        deliveredTargets,
      });
      await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });

      expect(requestGateway).not.toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ idempotencyKey: `approval-terminal-notice:${request.id}` }),
      );
      coordinator.close();
    },
  );
});

describe("createApprovalNativeRouteReporter", () => {
  it("keeps the local approval route visible when an unbound request has multiple runtimes", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const first = coordinator.createReporter(reporterOptions());
    const second = coordinator.createReporter(
      reporterOptions({
        accountId: "ops",
      }),
    );
    first.start();
    second.start();

    expect(coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(
      coordinator.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "ops",
      }),
    ).toBe(true);
    coordinator.close();
  });

  it("selects the sole eligible runtime for an unbound request", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinator.createReporter(
        reporterOptions({
          accountId,
          requestGateway,
          shouldHandle: () => eligible,
          classifyRoute: () => "unbound",
        }),
      );
    const defaultReporter = createReporter("default", true);
    const opsReporter = createReporter("ops", false);
    defaultReporter.start();
    opsReporter.start();
    const request = createRequest("approval-filtered", { turnSourceChannel: "telegram" });

    expect(defaultReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    expect(opsReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ineligible",
    });
    coordinator.close();
  });

  it("keeps each channel's sole eligible runtime independent", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (channel: string) =>
      coordinator.createReporter(
        reporterOptions({
          channel,
          requestGateway,
        }),
      );
    const telegramReporter = createReporter("telegram");
    const matrixReporter = createReporter("matrix");
    telegramReporter.start();
    matrixReporter.start();
    const request = createRequest("approval-two-channels");

    expect(telegramReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    expect(matrixReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    coordinator.close();
  });

  it("fails an unbound multi-account route visibly and keeps the owner snapshot sticky", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string) =>
      coordinator.createReporter(
        reporterOptions({
          accountId,
          requestGateway,
        }),
      );
    const first = createReporter("default");
    const second = createReporter("ops");
    first.start();
    second.start();
    const request = createRequest("deadbeef-1234-4567-89ab-cdef01234567", {
      turnSourceChannel: "telegram",
      turnSourceTo: "chat:123",
    });

    expect(first.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ambiguous-owner",
    });
    expect(second.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ambiguous-owner",
    });
    await first.reportSkipped({ approvalKind: "exec", request, reason: "ambiguous-owner" });
    await second.reportSkipped({ approvalKind: "exec", request, reason: "ambiguous-owner" });

    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        channel: "telegram",
        to: "chat:123",
        message:
          "Approval required, but multiple channel accounts can handle this request. Open the Control UI to approve it.",
      }),
    );
    expect(requestGateway).not.toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: expect.stringContaining("/approve") }),
    );

    const late = createReporter("late");
    late.start();
    expect(late.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "ineligible" });
    coordinator.close();
  });

  it("selects every eligible explicit owner and no unrelated account", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinator.createReporter(
        reporterOptions({
          accountId,
          requestGateway,
          shouldHandle: () => eligible,
          classifyRoute: () => "bound-or-explicit",
        }),
      );
    const first = createReporter("default", true);
    const second = createReporter("ops", true);
    const unrelated = createReporter("other", false);
    first.start();
    second.start();
    unrelated.start();
    const request = createRequest("approval-explicit-owners");

    expect(first.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "selected" });
    expect(second.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "selected" });
    expect(unrelated.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ineligible",
    });
    coordinator.close();
  });

  it("isolates active routes and cleanup between Gateway instances", () => {
    const first = createApprovalNativeRouteCoordinator();
    const second = createApprovalNativeRouteCoordinator();
    const firstReporter = first.createReporter(reporterOptions());
    const secondReporter = second.createReporter(
      reporterOptions({
        channel: "discord",
      }),
    );
    firstReporter.start();
    secondReporter.start();

    expect(
      first.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      second.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(false);

    first.close();
    expect(first.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(second.hasActiveRuntime({ approvalKind: "exec", channel: "discord" })).toBe(true);
    second.close();
  });

  it("cannot revive routes or notices after the owning Gateway closes", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const reporter = coordinator.createReporter(
      reporterOptions({
        requestGateway,
      }),
    );
    const request = createRequest("approval-after-close", {
      turnSourceChannel: "telegram",
      turnSourceTo: "chat:123",
    });

    reporter.start();
    coordinator.close();
    reporter.start();
    reporter.selectRequest({ approvalKind: "exec", request });
    await reporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

    const lateReporter = coordinator.createReporter(
      reporterOptions({
        requestGateway,
      }),
    );
    lateReporter.start();
    lateReporter.selectRequest({ approvalKind: "exec", request });
    await lateReporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

    expect(coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps route-notice cleanup timers to five minutes", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const requestGateway = createGatewayRequestMock();
      const reporter = createApprovalNativeRouteReporter({
        channel: "slack",
        channelLabel: "Slack",
        requestGateway,
      });
      reporter.start();

      reporter.selectRequest({
        approvalKind: "exec",
        request: {
          id: "approval-long",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
          },
          createdAtMs: 0,
          expiresAtMs: Date.now() + 24 * 60 * 60_000,
        },
      });

      const cleanupCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5 * 60_000);
      expect(cleanupCall).toBeDefined();
      const [cleanupCallback] = cleanupCall ?? [];
      expect(cleanupCallback).toBeTypeOf("function");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on runtimes that start after a request was already observed", async () => {
    const requestGateway = createGatewayRequestMock();
    const lateRuntimeGateway = createGatewayRequestMock();
    const request = createRequest("approval-1", {
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "1712345678.123456",
    });

    const reporter = createApprovalNativeRouteReporter({
      channel: "slack",
      channelLabel: "Slack",
      requestGateway,
    });
    reporter.start();
    reporter.selectRequest({
      approvalKind: "exec",
      request,
    });

    const lateReporter = createApprovalNativeRouteReporter({
      channel: "slack",
      channelLabel: "Slack",
      requestGateway: lateRuntimeGateway,
    });
    lateReporter.start();

    await reporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
          threadId: "1712345678.123456",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [approverDm("user:owner")],
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:approval-1",
    });
    expect(lateRuntimeGateway).not.toHaveBeenCalled();
  });

  it("does not suppress the notice when another account delivered to the same target id", async () => {
    const originGateway = createGatewayRequestMock();
    const otherGateway = createGatewayRequestMock();
    const request = createRequest("approval-2", {
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
    });

    const originReporter = createApprovalNativeRouteReporter({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work-a",
      requestGateway: originGateway,
    });
    const otherReporter = createApprovalNativeRouteReporter({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work-b",
      requestGateway: otherGateway,
    });
    originReporter.start();
    otherReporter.start();

    originReporter.selectRequest({
      approvalKind: "exec",
      request,
    });
    otherReporter.selectRequest({
      approvalKind: "exec",
      request,
    });

    await originReporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [approverDm("user:owner-a")],
    });
    await otherReporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [
        {
          surface: "origin",
          target: {
            to: "channel:C123",
          },
          reason: "fallback",
        },
      ],
    });

    expect(originGateway).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "work-a",
      threadId: undefined,
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:approval-2",
    });
    expect(otherGateway).not.toHaveBeenCalled();
  });

  it("sends a manual fallback notice when native delivery reaches no targets", async () => {
    const requestGateway = createGatewayRequestMock();
    const request = createRequest("deadbeef-1234-4567-89ab-cdef01234567", {
      allowedDecisions: ["allow-once", "deny"],
      turnSourceChannel: "discord",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "default",
    });

    const reporter = createApprovalNativeRouteReporter({
      channel: "discord",
      channelLabel: "Discord",
      requestGateway,
    });
    reporter.start();
    reporter.selectRequest({
      approvalKind: "exec",
      request,
    });

    await reporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [approverDm("user:owner")],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [],
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      channel: "discord",
      to: "channel:C123",
      accountId: "default",
      threadId: undefined,
      message:
        "Approval required. I could not deliver the native approval request.\n" +
        "Reply with: /approve deadbeef allow-once|deny\n" +
        "If the short code is ambiguous, use the full id in /approve.",
      idempotencyKey: "approval-route-notice:deadbeef-1234-4567-89ab-cdef01234567",
    });
  });
});
