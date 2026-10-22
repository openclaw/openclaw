import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter as createApprovalNativeRouteReporterRaw,
} from "./approval-native-route-coordinator.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

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

afterEach(async () => {
  await Promise.all(approvalRouteReporters.splice(0).map((reporter) => reporter.stop()));
  vi.useRealTimers();
});

function createGatewayRequestMock() {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })) as unknown as (<T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>) &
    ReturnType<typeof vi.fn>;
}

function approverDm(to: string) {
  return { surface: "approver-dm" as const, target: { to }, reason: "preferred" as const };
}

const selection = (request: ExecApprovalRequest) => ({ approvalKind: "exec" as const, request });

function coordinatedReporter(
  coordinator: ReturnType<typeof createApprovalNativeRouteCoordinator>,
  overrides: Partial<ReporterOptions> = {},
) {
  const reporter = coordinator.createReporter(reporterOptions(overrides));
  reporter.start();
  return reporter;
}

async function expectSelection(
  reporter: ReturnType<typeof createApprovalNativeRouteReporter>,
  request: ExecApprovalRequest,
  kind: Awaited<ReturnType<typeof reporter.selectRequest>>["kind"],
) {
  expect(await reporter.selectRequest(selection(request))).toEqual({ kind });
}

function delivery(
  request: ExecApprovalRequest,
  deliveredTargets: Parameters<
    ReturnType<typeof createApprovalNativeRouteReporter>["reportDelivery"]
  >[0]["deliveredTargets"],
  targets: Parameters<
    ReturnType<typeof createApprovalNativeRouteReporter>["reportDelivery"]
  >[0]["deliveryPlan"]["targets"] = [],
  threadId?: string,
) {
  return {
    ...selection(request),
    deliveryPlan: {
      targets,
      originTarget: { to: "channel:C123", ...(threadId ? { threadId } : {}) },
      notifyOriginWhenDmOnly: true,
    },
    deliveredTargets,
  };
}

describe("createApprovalNativeRouteReporter", () => {
  it.each([
    ["plugin", "Control UI or terminal UI"],
    ["system-agent", "Control UI"],
  ] as const)(
    "routes ambiguous %s ownership to a capable approval surface",
    async (approvalKind, surface) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const first = coordinatedReporter(coordinator, {
        handledKinds: new Set([approvalKind]),
        requestGateway,
      });
      const second = coordinatedReporter(coordinator, {
        handledKinds: new Set([approvalKind]),
        accountId: "ops",
        requestGateway,
      });
      const request = {
        ...createRequest(`ambiguous-${approvalKind}`, {
          turnSourceChannel: "telegram",
          turnSourceTo: "chat:123",
        }),
        request: {
          command: "echo hi",
          title: "Approve operation",
          description: "Synthetic approval",
          proposalHash: "synthetic-proposal",
          sessionId: "synthetic-session",
          allowedDecisions: ["allow-once", "deny"] as const,
          turnSourceChannel: "telegram",
          turnSourceTo: "chat:123",
        },
      };
      try {
        for (const reporter of [first, second]) {
          expect(await reporter.selectRequest({ approvalKind, request })).toEqual({
            kind: "ambiguous-owner",
          });
        }
        for (const reporter of [first, second]) {
          await reporter.reportSkipped({ approvalKind, request, reason: "ambiguous-owner" });
        }
        expect(requestGateway).toHaveBeenCalledTimes(1);
        expect(requestGateway).toHaveBeenCalledWith(
          "send",
          expect.objectContaining({
            message: `Approval required, but multiple channel accounts can handle this request. Open the ${surface} to approve it.`,
          }),
        );
      } finally {
        coordinator.close();
      }
    },
  );

  it.each([
    [false, "Matrix DMs or Telegram DMs"],
    [true, "Matrix or Telegram DMs"],
  ] as const)(
    "reports sorted unique cross-channel destinations with mixed surfaces=%s",
    async (mixed, destinations) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const request = createRequest("cross-channel-destinations", {
        turnSourceChannel: "discord",
        turnSourceTo: "channel:C123",
      });
      const reporters = [
        coordinatedReporter(coordinator, {
          channel: "telegram",
          channelLabel: "Telegram",
          requestGateway,
          classifyRoute: () => "bound-or-explicit",
        }),
        coordinatedReporter(coordinator, {
          channel: "matrix",
          channelLabel: "Matrix",
          requestGateway,
        }),
        coordinatedReporter(coordinator, {
          channel: "telegram",
          channelLabel: "Telegram",
          accountId: "ops",
          requestGateway,
          classifyRoute: () => "bound-or-explicit",
        }),
      ];
      try {
        for (const reporter of reporters) {
          await expectSelection(reporter, request, "selected");
        }
        for (const [index, reporter] of reporters.entries()) {
          await reporter.reportDelivery(
            delivery(request, [
              approverDm("user:owner"),
              ...(mixed && index === 1
                ? [
                    {
                      surface: "origin" as const,
                      target: { to: "room:other" },
                      reason: "preferred" as const,
                    },
                  ]
                : []),
            ]),
          );
        }
        expect(requestGateway).toHaveBeenCalledTimes(1);
        expect(requestGateway).toHaveBeenCalledWith(
          "send",
          expect.objectContaining({
            channel: "discord",
            to: "channel:C123",
            message: `Approval required. I sent the approval request to ${destinations}, not this chat.`,
          }),
        );
      } finally {
        coordinator.close();
      }
    },
  );

  it("does not send a route notice without delivered destinations", async () => {
    const requestGateway = createGatewayRequestMock();
    const reporter = createApprovalNativeRouteReporter({ requestGateway });
    reporter.start();
    const request = createRequest("no-destinations", {
      turnSourceChannel: "telegram",
      turnSourceTo: "chat:123",
    });
    await reporter.selectRequest(selection(request));
    await reporter.reportDelivery(delivery(request, []));
    expect(requestGateway).not.toHaveBeenCalled();
  });

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

  it("selects the sole eligible runtime after async account eligibility settles", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinator.createReporter(
        reporterOptions({
          accountId,
          requestGateway,
          shouldHandle: async () => eligible,
          classifyRoute: () => "unbound",
        }),
      );
    const defaultReporter = createReporter("default", true);
    const opsReporter = createReporter("ops", false);
    defaultReporter.start();
    opsReporter.start();
    const request = createRequest("approval-filtered", { turnSourceChannel: "telegram" });

    expect(await defaultReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    expect(await opsReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ineligible",
    });
    coordinator.close();
  });

  it("drops an earlier eligible account that stops while another account is preparing", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const preparing = createDeferred();
    const eligibility = createDeferred<boolean>();
    const first = coordinatedReporter(coordinator);
    const second = coordinatedReporter(coordinator, {
      accountId: "ops",
      shouldHandle: () => {
        preparing.resolve();
        return eligibility.promise;
      },
    });
    const request = createRequest("approval-stopped-during-selection");
    const selecting = first.selectRequest(selection(request));
    await preparing.promise;
    await first.stop();
    eligibility.resolve(true);
    expect(await selecting).toEqual({ kind: "ineligible" });
    await expectSelection(second, request, "selected");
    coordinator.close();
  });

  it("keeps each channel's sole eligible runtime independent", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (channel: string) =>
      coordinatedReporter(coordinator, { channel, requestGateway });
    const telegramReporter = createReporter("telegram");
    const matrixReporter = createReporter("matrix");
    const request = createRequest("approval-two-channels");

    await expectSelection(telegramReporter, request, "selected");
    await expectSelection(matrixReporter, request, "selected");
    coordinator.close();
  });

  it("fails an unbound multi-account route visibly and keeps the owner snapshot sticky", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string) =>
      coordinatedReporter(coordinator, { accountId, requestGateway });
    const first = createReporter("default");
    const second = createReporter("ops");
    const request = createRequest("deadbeef-1234-4567-89ab-cdef01234567", {
      turnSourceChannel: "telegram",
      turnSourceTo: "chat:123",
    });

    await expectSelection(first, request, "ambiguous-owner");
    await expectSelection(second, request, "ambiguous-owner");
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
    await expectSelection(late, request, "ineligible");
    coordinator.close();
  });

  it("selects every eligible explicit owner and no unrelated account", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinatedReporter(coordinator, {
        accountId,
        requestGateway,
        shouldHandle: async () => eligible,
        classifyRoute: () => "bound-or-explicit",
      });
    const first = createReporter("default", true);
    const second = createReporter("ops", true);
    const unrelated = createReporter("other", false);
    const request = createRequest("approval-explicit-owners");

    await expectSelection(first, request, "selected");
    await expectSelection(second, request, "selected");
    await expectSelection(unrelated, request, "ineligible");
    coordinator.close();
  });

  it("isolates active routes and cleanup between Gateway instances", () => {
    const first = createApprovalNativeRouteCoordinator();
    const second = createApprovalNativeRouteCoordinator();
    coordinatedReporter(first);
    coordinatedReporter(second, { channel: "discord" });

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
    const reporter = coordinatedReporter(coordinator, { requestGateway });
    const request = createRequest("approval-after-close", {
      turnSourceChannel: "telegram",
      turnSourceTo: "chat:123",
    });

    coordinator.close();
    reporter.start();
    await reporter.selectRequest({ approvalKind: "exec", request });
    await reporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

    const lateReporter = coordinatedReporter(coordinator, { requestGateway });
    await lateReporter.selectRequest({ approvalKind: "exec", request });
    await lateReporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

    expect(coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps route-notice cleanup timers to five minutes", async () => {
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

      await reporter.selectRequest({
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
    await reporter.selectRequest(selection(request));

    const lateReporter = createApprovalNativeRouteReporter({
      channel: "slack",
      channelLabel: "Slack",
      requestGateway: lateRuntimeGateway,
    });
    lateReporter.start();

    await reporter.reportDelivery(
      delivery(request, [approverDm("user:owner")], [], "1712345678.123456"),
    );

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

    await originReporter.selectRequest(selection(request));
    await otherReporter.selectRequest(selection(request));

    await originReporter.reportDelivery(delivery(request, [approverDm("user:owner-a")]));
    await otherReporter.reportDelivery(
      delivery(request, [
        { surface: "origin", target: { to: "channel:C123" }, reason: "fallback" },
      ]),
    );

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
    await reporter.selectRequest(selection(request));

    await reporter.reportDelivery(delivery(request, [], [approverDm("user:owner")]));

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
