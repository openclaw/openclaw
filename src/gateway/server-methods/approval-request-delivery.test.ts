import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { handlePendingApprovalRequestWithDelivery } from "./approval-request-delivery.js";
import { createContext } from "./approval.test-support.js";

const approvalDeliveryCallers = [
  {
    name: "exec approvals",
    approvalKind: "exec",
    source: "rpc",
    id: "approval-first-exec-delivery",
    request: { command: "echo ok" },
  },
  {
    name: "plugin approvals",
    approvalKind: "plugin",
    source: "rpc",
    id: "plugin:approval-first-plugin-delivery",
    request: { pluginId: "example", title: "Sensitive action", description: "Approve action" },
  },
  {
    name: "plugin node policies",
    approvalKind: "plugin",
    source: "node-policy",
    id: "plugin:approval-first-node-policy-delivery",
    request: {
      pluginId: "example",
      title: "Sensitive node action",
      description: "Approve node action",
      severity: "warning",
    },
  },
] as const;

type DeliveryParams = Parameters<
  typeof handlePendingApprovalRequestWithDelivery<"exec" | "plugin">
>[0];

function createDeliveryFixture(
  test: TestContext,
  caller: (typeof approvalDeliveryCallers)[number] = approvalDeliveryCallers[0],
) {
  const manager = createTestApprovalManager<
    ExecApprovalRequestPayload | PluginApprovalRequestPayload
  >(test, {
    approvalKind: caller.approvalKind,
  });
  const record = manager.create(caller.request, 60_000, caller.id);
  const decision = createDeferredCore<ExecApprovalDecision | null>();
  // Persistence/decision custody is a separate owner; delivery still uses its real work tracker.
  vi.spyOn(manager, "registerDecisionHandoff").mockImplementation((_id, run) => ({
    observation: decision.promise.then(run),
    abandon: () => decision.resolve(null),
  }));
  const expire = vi.spyOn(manager, "expire").mockImplementation(async () => {
    decision.resolve(null);
    return true;
  });
  const context = createContext();
  context.getApprovalClientConnIds = () => new Set();
  const webPush = vi.fn(() => false);
  context.approvalWebPushDelivery = {
    handleRequested: webPush,
    handleResolved: vi.fn(),
    handleExpired: vi.fn(),
  };
  const respond = vi.fn();
  const requests: Promise<void>[] = [];
  test.onTestFinished(async () => {
    decision.resolve(null);
    await Promise.allSettled(requests);
  });
  return {
    manager,
    record,
    context,
    respond,
    expire,
    webPush,
    settle: () => decision.resolve("deny"),
    start: (
      routes: Pick<DeliveryParams, "forwardRequest" | "getIosPushDelivery"> = {
        getIosPushDelivery: () => undefined,
      },
    ) => {
      const request = handlePendingApprovalRequestWithDelivery({
        approvalKind: caller.approvalKind,
        source: caller.source,
        manager,
        record,
        respond,
        context,
        twoPhase: true,
        ...routes,
      });
      requests.push(request);
      return request;
    },
  };
}

function expectAccepted(fixture: ReturnType<typeof createDeliveryFixture>) {
  expect(fixture.respond).toHaveBeenCalledWith(
    true,
    {
      status: "accepted",
      id: fixture.record.id,
      deliveryRoute: "forwarder",
      createdAtMs: fixture.record.createdAtMs,
      expiresAtMs: fixture.record.expiresAtMs,
    },
    undefined,
  );
  expect(fixture.expire).not.toHaveBeenCalled();
}

describe("handlePendingApprovalRequestWithDelivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires a request when no external routes or approval clients exist", async (test) => {
    const fixture = createDeliveryFixture(test);
    await fixture.start();

    expect(fixture.expire).toHaveBeenCalledExactlyOnceWith(fixture.record.id, "no-approval-route");
    expect(fixture.respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        id: fixture.record.id,
        decision: null,
        createdAtMs: fixture.record.createdAtMs,
        expiresAtMs: fixture.record.expiresAtMs,
      },
      undefined,
    );
  });

  it("accepts a request delivered by Web Push", async (test) => {
    const fixture = createDeliveryFixture(test);
    fixture.webPush.mockResolvedValue(true);
    const request = fixture.start();
    await vi.advanceTimersByTimeAsync(0);

    expectAccepted(fixture);
    expect(fixture.webPush).toHaveBeenCalledExactlyOnceWith(fixture.record);
    fixture.settle();
    await request;
  });

  it.for(
    (["forward", "push"] as const).flatMap((successfulRoute) =>
      approvalDeliveryCallers.map((caller) => ({ caller, successfulRoute })),
    ),
  )(
    "accepts $caller.name through $successfulRoute while retaining the other route",
    async ({ caller, successfulRoute }, test) => {
      const fixture = createDeliveryFixture(test, caller);
      const release = createDeferredCore<boolean>();
      const started: string[] = [];
      let pendingRouteFinished = false;
      const route = async (name: "forward" | "push") => {
        started.push(name);
        if (name === successfulRoute) {
          return true;
        }
        const delivered = await release.promise;
        pendingRouteFinished = true;
        return delivered;
      };
      const forwardRequest = vi.fn(() => route("forward"));
      const handleRequested = vi.fn(() => route("push"));
      const request = fixture.start({
        forwardRequest,
        getIosPushDelivery: () => ({ handleRequested }),
      });
      let draining: Promise<void> | undefined;
      let drained = false;
      try {
        expect(started).toEqual(["forward", "push"]);
        await vi.advanceTimersByTimeAsync(0);
        expectAccepted(fixture);
        const event = {
          approvalKind: caller.approvalKind,
          id: fixture.record.id,
          request: caller.request,
          createdAtMs: fixture.record.createdAtMs,
          expiresAtMs: fixture.record.expiresAtMs,
        };
        expect(fixture.context.broadcastToConnIds).toHaveBeenCalledWith(
          `${caller.approvalKind}.approval.requested`,
          event,
          new Set(),
          { dropIfSlow: true },
        );
        expect(forwardRequest).toHaveBeenCalledExactlyOnceWith(event);
        expect(handleRequested).toHaveBeenCalledExactlyOnceWith(event, {
          isTargetVisible: expect.any(Function),
        });
        expect(pendingRouteFinished).toBe(false);
        fixture.settle();
        await request;
        expect(fixture.respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({ decision: "deny" }),
          undefined,
        );
        draining = fixture.manager.drain().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(drained).toBe(false);
        release.resolve(true);
        await draining;
        expect(pendingRouteFinished).toBe(true);
      } finally {
        release.resolve(true);
        fixture.settle();
        await request;
        await (draining ?? fixture.manager.drain());
      }
    },
  );

  it.for([
    { name: "both routes decline", forwardRejects: false, pushRejects: false },
    { name: "forwarding rejects", forwardRejects: true, pushRejects: false },
    { name: "iOS push rejects", forwardRejects: false, pushRejects: true },
    { name: "both routes reject", forwardRejects: true, pushRejects: true },
  ])("expires after $name", async ({ forwardRejects, pushRejects }, test) => {
    const fixture = createDeliveryFixture(test);
    await fixture.start({
      forwardRequest: async () => {
        if (forwardRejects) {
          throw new Error("forward offline");
        }
        return false;
      },
      getIosPushDelivery: () => ({
        handleRequested: async () => {
          if (pushRejects) {
            throw new Error("push offline");
          }
          return false;
        },
      }),
    });

    expect(fixture.expire).toHaveBeenCalledExactlyOnceWith(fixture.record.id, "no-approval-route");
    expect(fixture.respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ decision: null }),
      undefined,
    );
    const error = fixture.context.logGateway.error;
    expect(error).toHaveBeenCalledTimes(Number(forwardRejects) + Number(pushRejects));
    if (forwardRejects) {
      expect(error).toHaveBeenCalledWith(
        "exec approvals: forward request failed: Error: forward offline",
      );
    }
    if (pushRejects) {
      expect(error).toHaveBeenCalledWith(
        "exec approvals: iOS push request failed: Error: push offline",
      );
    }
  });

  it("handles a late route rejection after accepting and answering the request", async (test) => {
    const fixture = createDeliveryFixture(test);
    const pendingPush = createDeferredCore<boolean>();
    const request = fixture.start({
      forwardRequest: async () => true,
      getIosPushDelivery: () => ({ handleRequested: () => pendingPush.promise }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expectAccepted(fixture);
      fixture.settle();
      await request;
      expect(fixture.context.logGateway.error).not.toHaveBeenCalled();
      pendingPush.reject(new Error("offline after delivery"));
      await fixture.manager.drain();
      expect(fixture.context.logGateway.error).toHaveBeenCalledExactlyOnceWith(
        "exec approvals: iOS push request failed: Error: offline after delivery",
      );
    } finally {
      pendingPush.resolve(false);
      fixture.settle();
      await request;
    }
  });

  it.for(["forward", "push"] as const)(
    "starts both routes and isolates a %s failure",
    async (failedRoute, test) => {
      const fixture = createDeliveryFixture(test);
      const successfulResult = createDeferredCore<boolean>();
      const started: string[] = [];
      const route = (name: "forward" | "push") => {
        started.push(name);
        return name === failedRoute
          ? Promise.reject(new Error("offline"))
          : successfulResult.promise;
      };
      const request = fixture.start({
        forwardRequest: () => route("forward"),
        getIosPushDelivery: () => ({ handleRequested: () => route("push") }),
      });
      try {
        expect(started).toEqual(["forward", "push"]);
        successfulResult.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        expectAccepted(fixture);
        expect(fixture.context.logGateway.error).toHaveBeenCalledExactlyOnceWith(
          `exec approvals: ${failedRoute === "forward" ? "forward" : "iOS push"} request failed: Error: offline`,
        );
      } finally {
        successfulResult.resolve(true);
        fixture.settle();
        await request;
      }
    },
  );

  it("limits mobile delivery to the bound requester, reviewers, and administrators", async (test) => {
    const fixture = createDeliveryFixture(test);
    fixture.record.requestedByDeviceId = "requester";
    fixture.record.approvalReviewerDeviceIds = ["reviewer"];
    const visible: boolean[] = [];
    const request = fixture.start({
      getIosPushDelivery: () => ({
        handleRequested: async (_event, options) => {
          for (const target of [
            { deviceId: "requester", scopes: [] },
            { deviceId: "reviewer", scopes: ["operator.approvals"] },
            { deviceId: "reviewer", scopes: [] },
            { deviceId: "other", scopes: ["operator.approvals"] },
            { deviceId: "admin", scopes: ["operator.admin"] },
          ]) {
            visible.push(options?.isTargetVisible?.(target) === true);
          }
          return true;
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expectAccepted(fixture);
    expect(visible).toEqual([true, true, false, false, true]);
    fixture.settle();
    await request;
  });
});
