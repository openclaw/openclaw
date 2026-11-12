import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createApprovalNativeRouteCoordinator as createCoordinator,
  createApprovalNativeRouteReporter as createApprovalNativeRouteReporterRaw,
} from "./approval-native-route-coordinator.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

const coordinators: Array<ReturnType<typeof createCoordinator>> = [];
const approvalRouteReporters: Reporter[] = [];
function createApprovalNativeRouteCoordinator() {
  const coordinator = createCoordinator();
  coordinators.push(coordinator);
  return coordinator;
}
type ReporterOptions = Parameters<typeof createApprovalNativeRouteReporterRaw>[0];
type Reporter = ReturnType<typeof createApprovalNativeRouteReporterRaw>;
type Delivery = Parameters<Reporter["reportDelivery"]>[0];
let requestGateway: ReturnType<typeof createGatewayRequestMock>;
let coordinator: ReturnType<typeof createCoordinator>;
beforeEach(() => {
  requestGateway = createGatewayRequestMock();
  coordinator = createApprovalNativeRouteCoordinator();
});

function reporterOptions(overrides: Partial<ReporterOptions> = {}): ReporterOptions {
  return {
    shouldHandle: () => true,
    classifyRoute: () => "unbound",
    handledKinds: new Set(["exec"]),
    channel: "telegram",
    accountId: "default",
    requestGateway,
    ...overrides,
  };
}

function createApprovalNativeRouteReporter(
  params: Partial<ReporterOptions> = {},
  owner?: ReturnType<typeof createCoordinator>,
) {
  const reporter = (owner?.createReporter ?? createApprovalNativeRouteReporterRaw)(
    reporterOptions(params),
  );
  if (!owner) {
    approvalRouteReporters.push(reporter);
  }
  reporter.start();
  return reporter;
}

function createRequest(
  id: string,
  request: Partial<ExecApprovalRequest["request"]> = {},
  expiresAtMs = Date.now() + 60_000,
): ExecApprovalRequest {
  return {
    id,
    request: { command: "echo hi", ...request },
    createdAtMs: 0,
    expiresAtMs,
  };
}

function originRequest(
  id: string,
  channel = "slack",
  extra: Partial<ExecApprovalRequest["request"]> = {},
) {
  return createRequest(id, {
    turnSourceChannel: channel,
    turnSourceTo: "channel:C123",
    ...extra,
  });
}

function expectNotice(
  gateway: ReturnType<typeof createGatewayRequestMock>,
  id: string,
  message: string,
  overrides: Record<string, unknown> = {},
) {
  expect(gateway).toHaveBeenCalledWith("send", {
    channel: "slack",
    to: "channel:C123",
    accountId: "default",
    threadId: undefined,
    message,
    idempotencyKey: `approval-route-notice:${id}`,
    ...overrides,
  });
}

const dmNotice = "Approval required. I sent the approval request to Slack DMs, not this chat.";

afterEach(async () => {
  await Promise.all(approvalRouteReporters.splice(0).map((reporter) => reporter.stop()));
  coordinators.splice(0).forEach((owner) => owner.close());
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
const activeRoute = (channel = "telegram", accountId?: string) => ({
  approvalKind: "exec" as const,
  channel,
  ...(accountId ? { accountId } : {}),
});

function coordinatedReporter(
  owner: ReturnType<typeof createApprovalNativeRouteCoordinator>,
  overrides: Partial<ReporterOptions> = {},
) {
  return createApprovalNativeRouteReporter(overrides, owner);
}

const slackReporter = (overrides: Partial<ReporterOptions> = {}) =>
  createApprovalNativeRouteReporter({ channel: "slack", channelLabel: "Slack", ...overrides });
const accountRoute = (accountId: string, eligible = true, channel = "telegram") => ({
  accountId,
  channel,
  shouldHandle: async () => eligible,
});

async function expectSelection(
  reporter: Reporter,
  request: ExecApprovalRequest,
  kind: Awaited<ReturnType<typeof reporter.selectRequest>>["kind"],
) {
  expect(await reporter.selectRequest(selection(request))).toEqual({ kind });
}

function delivery(
  request: ExecApprovalRequest,
  deliveredTargets: Delivery["deliveredTargets"],
  targets: Delivery["deliveryPlan"]["targets"] = [],
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
    ["exec", "Control UI"],
    ["plugin", "Control UI or terminal UI"],
    ["system-agent", "Control UI"],
  ] as const)(
    "routes ambiguous %s ownership to a capable approval surface",
    async (approvalKind, surface) => {
      const first = coordinatedReporter(coordinator, {
        handledKinds: new Set([approvalKind]),
      });
      const second = coordinatedReporter(coordinator, {
        handledKinds: new Set([approvalKind]),
        accountId: "ops",
      });
      const request = originRequest(`ambiguous-${approvalKind}`, "telegram");
      for (const reporter of [first, second]) {
        expect(await reporter.selectRequest({ approvalKind, request })).toEqual({
          kind: "ambiguous-owner",
        });
      }
      for (const reporter of [first, second]) {
        await reporter.reportSkipped({ approvalKind, request, reason: "ambiguous-owner" });
      }
      expect(requestGateway).toHaveBeenCalledTimes(1);
      expectNotice(
        requestGateway,
        request.id,
        `Approval required, but multiple channel accounts can handle this request. Open the ${surface} to approve it.`,
        { channel: "telegram", accountId: undefined },
      );
      expect(requestGateway).not.toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ message: expect.stringContaining("/approve") }),
      );
      const late = coordinatedReporter(coordinator, {
        accountId: "late",
        handledKinds: new Set([approvalKind]),
      });
      expect(await late.selectRequest({ approvalKind, request })).toEqual({ kind: "ineligible" });
    },
  );

  it.each([
    [false, "Matrix DMs or Telegram DMs"],
    [true, "Matrix or Telegram DMs"],
  ] as const)(
    "reports sorted unique cross-channel destinations with mixed surfaces=%s",
    async (mixed, destinations) => {
      const request = originRequest("cross-channel-destinations", "discord");
      const reporters = (
        [
          ["telegram", "Telegram", "default"],
          ["matrix", "Matrix", "default"],
          ["telegram", "Telegram", "ops"],
        ] as const
      ).map(([channel, channelLabel, accountId]) =>
        coordinatedReporter(coordinator, {
          channel,
          channelLabel,
          accountId,
          classifyRoute: () => (channel === "telegram" ? "bound-or-explicit" : "unbound"),
        }),
      );
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
      expectNotice(
        requestGateway,
        request.id,
        `Approval required. I sent the approval request to ${destinations}, not this chat.`,
        { channel: "discord", accountId: undefined },
      );
    },
  );

  it("does not send a route notice without delivered destinations", async () => {
    const reporter = createApprovalNativeRouteReporter();
    const request = originRequest("no-destinations", "telegram");
    await reporter.selectRequest(selection(request));
    await reporter.reportDelivery(delivery(request, []));
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it("keeps the local approval route visible when an unbound request has multiple runtimes", () => {
    coordinatedReporter(coordinator);
    coordinatedReporter(coordinator, { accountId: "ops" });
    expect(coordinator.hasActiveRuntime(activeRoute())).toBe(false);
    expect(coordinator.hasActiveRuntime(activeRoute("telegram", "ops"))).toBe(true);
  });

  it.each([
    [
      "sole async account",
      [accountRoute("default"), accountRoute("ops", false)],
      false,
      ["selected", "ineligible"],
    ],
    [
      "independent channels",
      [accountRoute("default"), accountRoute("default", true, "matrix")],
      false,
      ["selected", "selected"],
    ],
    [
      "explicit owners",
      [accountRoute("default"), accountRoute("ops"), accountRoute("other", false)],
      true,
      ["selected", "selected", "ineligible"],
    ],
  ] as const)(
    "selects %s after account eligibility settles",
    async (_name, routes, explicit, verdicts) => {
      const reporters = routes.map((route) =>
        coordinatedReporter(coordinator, {
          ...route,
          classifyRoute: () => (explicit ? "bound-or-explicit" : "unbound"),
        }),
      );
      const request = createRequest("approval-filtered", { turnSourceChannel: "telegram" });
      for (const [index, reporter] of reporters.entries()) {
        await expectSelection(reporter, request, verdicts[index]!);
      }
    },
  );
  it("drops an earlier eligible account that stops while another account is preparing", async () => {
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
  });

  it("isolates active routes and cleanup between Gateway instances", () => {
    const first = createApprovalNativeRouteCoordinator();
    const second = createApprovalNativeRouteCoordinator();
    coordinatedReporter(first);
    coordinatedReporter(second, { channel: "discord" });

    expect(first.hasActiveRuntime(activeRoute("telegram", "default"))).toBe(true);
    expect(second.hasActiveRuntime(activeRoute("telegram", "default"))).toBe(false);

    first.close();
    expect(first.hasActiveRuntime(activeRoute())).toBe(false);
    expect(second.hasActiveRuntime(activeRoute("discord"))).toBe(true);
    second.close();
  });

  it("cannot revive routes or notices after the owning Gateway closes", async () => {
    vi.useFakeTimers();
    const reporter = coordinatedReporter(coordinator);
    const request = originRequest("approval-after-close", "telegram");

    coordinator.close();
    reporter.start();
    await reporter.selectRequest(selection(request));
    await reporter.reportSkipped({ ...selection(request), reason: "ineligible" });

    const lateReporter = coordinatedReporter(coordinator);
    await lateReporter.selectRequest(selection(request));
    await lateReporter.reportSkipped({ ...selection(request), reason: "ineligible" });

    expect(coordinator.hasActiveRuntime(activeRoute())).toBe(false);
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps route-notice cleanup timers to five minutes", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const reporter = slackReporter();
    await reporter.selectRequest(
      selection(createRequest("approval-long", {}, Date.now() + 24 * 60 * 60_000)),
    );
    const cleanupCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5 * 60_000);
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall?.[0]).toBeTypeOf("function");
  });

  it("does not wait on runtimes that start after a request was already observed", async () => {
    const lateRuntimeGateway = createGatewayRequestMock();
    const request = originRequest("approval-1", "slack", {
      turnSourceAccountId: "default",
      turnSourceThreadId: "1712345678.123456",
    });

    const reporter = slackReporter();
    await reporter.selectRequest(selection(request));

    slackReporter({ requestGateway: lateRuntimeGateway });

    await reporter.reportDelivery(
      delivery(request, [approverDm("user:owner")], [], "1712345678.123456"),
    );

    expectNotice(requestGateway, request.id, dmNotice, {
      threadId: "1712345678.123456",
    });
    expect(lateRuntimeGateway).not.toHaveBeenCalled();
  });

  it("does not suppress the notice when another account delivered to the same target id", async () => {
    const originGateway = createGatewayRequestMock();
    const otherGateway = createGatewayRequestMock();
    const request = originRequest("approval-2");

    const originReporter = slackReporter({
      accountId: "work-a",
      requestGateway: originGateway,
    });
    const otherReporter = slackReporter({
      accountId: "work-b",
      requestGateway: otherGateway,
    });

    await originReporter.selectRequest(selection(request));
    await otherReporter.selectRequest(selection(request));

    await originReporter.reportDelivery(delivery(request, [approverDm("user:owner-a")]));
    await otherReporter.reportDelivery(
      delivery(request, [
        { surface: "origin", target: { to: "channel:C123" }, reason: "fallback" },
      ]),
    );

    expectNotice(originGateway, request.id, dmNotice, { accountId: "work-a" });
    expect(otherGateway).not.toHaveBeenCalled();
  });

  it("sends a manual fallback notice when native delivery reaches no targets", async () => {
    const request = originRequest("deadbeef-1234-4567-89ab-cdef01234567", "discord", {
      allowedDecisions: ["allow-once", "deny"],
      turnSourceAccountId: "default",
    });

    const reporter = createApprovalNativeRouteReporter({
      channel: "discord",
      channelLabel: "Discord",
    });
    await reporter.selectRequest(selection(request));

    await reporter.reportDelivery(delivery(request, [], [approverDm("user:owner")]));

    expectNotice(
      requestGateway,
      request.id,
      "Approval required. I could not deliver the native approval request.\n" +
        "Reply with: /approve deadbeef allow-once|deny\n" +
        "If the short code is ambiguous, use the full id in /approve.",
      { channel: "discord" },
    );
  });
});
