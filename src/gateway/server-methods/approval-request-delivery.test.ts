import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { handlePendingApprovalRequestWithDelivery } from "./approval-request-delivery.js";
import { createContext } from "./approval.test-support.js";

const approvalDeliveryCallers = ["exec", "plugin", "node-policy"] as const;
const pluginRequest = {
  pluginId: "example",
  title: "Sensitive action",
  description: "Approve action",
};

type DeliveryParams = Parameters<
  typeof handlePendingApprovalRequestWithDelivery<"exec" | "plugin">
>[0];
type IosDelivery = ReturnType<DeliveryParams["getIosPushDelivery"]>;

async function createDeliveryFixture(
  test: TestContext,
  caller: (typeof approvalDeliveryCallers)[number] = approvalDeliveryCallers[0],
) {
  const approvalKind = caller === "exec" ? "exec" : "plugin";
  const source = caller === "node-policy" ? "node-policy" : "rpc";
  const payload =
    approvalKind === "exec"
      ? { command: "echo ok" }
      : { ...pluginRequest, ...(source === "node-policy" ? { severity: "warning" as const } : {}) };
  const manager = createTestApprovalManager<DeliveryParams["record"]["request"]>(test, {
    approvalKind,
  });
  const record = manager.create(payload, 60_000, `${approvalKind}:${source}`);
  await manager.register(record, 60_000);
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
  const pendingRoutes: ReturnType<typeof createDeferredCore<boolean>>[] = [];
  test.onTestFinished(async () => {
    pendingRoutes.forEach((route) => route.resolve(false));
    decision.resolve(null);
    await Promise.allSettled(requests);
  });
  const { id, createdAtMs, expiresAtMs } = record;
  const timing = { id, createdAtMs, expiresAtMs };
  const pending = { manager, record, context, respond };
  return {
    ...pending,
    expire,
    webPush,
    timing,
    deferredRoute: () => {
      const route = createDeferredCore<boolean>();
      pendingRoutes.push(route);
      return route;
    },
    event: {
      ...timing,
      approvalKind,
      request: payload,
    },
    settle: async (request: Promise<void>) => {
      decision.resolve("deny");
      await request;
    },
    start: (forwardRequest?: DeliveryParams["forwardRequest"], ios?: IosDelivery) => {
      const request = handlePendingApprovalRequestWithDelivery({
        approvalKind,
        source,
        ...pending,
        twoPhase: true,
        forwardRequest,
        getIosPushDelivery: () => ios,
      });
      requests.push(request);
      return request;
    },
  };
}

type DeliveryFixture = Awaited<ReturnType<typeof createDeliveryFixture>>;

async function expectAccepted(fixture: DeliveryFixture) {
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.respond).toHaveBeenCalledWith(
    true,
    { ...fixture.timing, status: "accepted", deliveryRoute: "forwarder" },
    undefined,
  );
  expect(fixture.expire).not.toHaveBeenCalled();
}

function expectExpired({ expire, record, respond, timing }: DeliveryFixture) {
  expect(expire).toHaveBeenCalledExactlyOnceWith(record.id, "no-approval-route");
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ...timing, decision: null }, undefined);
}

function expectErrors(fixture: DeliveryFixture, ...messages: string[]) {
  const error = fixture.context.logGateway.error;
  expect(error).toHaveBeenCalledTimes(messages.length);
  messages.forEach((message) => expect(error).toHaveBeenCalledWith(`exec approvals: ${message}`));
}

function declined(rejects: boolean, message: string) {
  return () => (rejects ? Promise.reject(new Error(message)) : Promise.resolve(false));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("expires a request when no external routes or approval clients exist", async (test) => {
  const fixture = await createDeliveryFixture(test);
  await fixture.start();

  expectExpired(fixture);
});

it("accepts a request delivered by Web Push", async (test) => {
  const fixture = await createDeliveryFixture(test);
  fixture.webPush.mockResolvedValue(true);
  const request = fixture.start();
  await expectAccepted(fixture);
  expect(fixture.webPush).toHaveBeenCalledExactlyOnceWith(fixture.record);
  await fixture.settle(request);
});

it.for(
  (["forward", "push"] as const).flatMap((successfulRoute) =>
    approvalDeliveryCallers.map((caller) => ({ caller, successfulRoute })),
  ),
)(
  "accepts $caller through $successfulRoute while retaining the other route",
  async ({ caller, successfulRoute }, test) => {
    const fixture = await createDeliveryFixture(test, caller);
    const release = fixture.deferredRoute();
    const started: string[] = [];
    const route = async (name: "forward" | "push") => {
      started.push(name);
      if (name === successfulRoute) {
        return true;
      }
      return release.promise;
    };
    const forwardRequest = vi.fn(() => route("forward"));
    const handleRequested = vi.fn(() => route("push"));
    const request = fixture.start(forwardRequest, { handleRequested });
    let drained = false;
    expect(started).toEqual(["forward", "push"]);
    await expectAccepted(fixture);
    const { event } = fixture;
    expect(fixture.context.broadcastToConnIds).toHaveBeenCalledWith(
      `${event.approvalKind}.approval.requested`,
      event,
      new Set(),
      { dropIfSlow: true },
    );
    expect(forwardRequest).toHaveBeenCalledExactlyOnceWith(event);
    expect(handleRequested).toHaveBeenCalledExactlyOnceWith(event, {
      isTargetVisible: expect.any(Function),
    });
    await fixture.settle(request);
    expect(fixture.respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ decision: "deny" }),
      undefined,
    );
    const draining = fixture.manager.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    release.resolve(true);
    await draining;
  },
);

it.for([
  { name: "both routes decline", forwardRejects: false, pushRejects: false },
  { name: "forwarding rejects", forwardRejects: true, pushRejects: false },
  { name: "iOS push rejects", forwardRejects: false, pushRejects: true },
  { name: "both routes reject", forwardRejects: true, pushRejects: true },
])("expires after $name", async ({ forwardRejects, pushRejects }, test) => {
  const fixture = await createDeliveryFixture(test);
  await fixture.start(declined(forwardRejects, "forward offline"), {
    handleRequested: declined(pushRejects, "push offline"),
  });

  expectExpired(fixture);
  expectErrors(
    fixture,
    ...(forwardRejects ? ["forward request failed: Error: forward offline"] : []),
    ...(pushRejects ? ["iOS push request failed: Error: push offline"] : []),
  );
});

it("handles a late route rejection after accepting and answering the request", async (test) => {
  const fixture = await createDeliveryFixture(test);
  const pendingPush = fixture.deferredRoute();
  const request = fixture.start(async () => true, { handleRequested: () => pendingPush.promise });
  await expectAccepted(fixture);
  await fixture.settle(request);
  expectErrors(fixture);
  pendingPush.reject(new Error("offline after delivery"));
  await fixture.manager.drain();
  expectErrors(fixture, "iOS push request failed: Error: offline after delivery");
});

it.for(["forward", "push"] as const)(
  "starts both routes and isolates a %s failure",
  async (failedRoute, test) => {
    const fixture = await createDeliveryFixture(test);
    const successfulResult = fixture.deferredRoute();
    const started: string[] = [];
    const route = (name: "forward" | "push") => {
      started.push(name);
      return name === failedRoute ? Promise.reject(new Error("offline")) : successfulResult.promise;
    };
    const request = fixture.start(() => route("forward"), {
      handleRequested: () => route("push"),
    });
    expect(started).toEqual(["forward", "push"]);
    successfulResult.resolve(true);
    await expectAccepted(fixture);
    expectErrors(
      fixture,
      `${failedRoute === "forward" ? "forward" : "iOS push"} request failed: Error: offline`,
    );
    await fixture.settle(request);
  },
);

it("limits mobile delivery to the bound requester, reviewers, and administrators", async (test) => {
  const fixture = await createDeliveryFixture(test);
  fixture.record.requestedByDeviceId = "requester";
  fixture.record.approvalReviewerDeviceIds = ["reviewer"];
  const visible: boolean[] = [];
  const request = fixture.start(undefined, {
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
  });
  await expectAccepted(fixture);
  expect(visible).toEqual([true, true, false, false, true]);
  await fixture.settle(request);
});
