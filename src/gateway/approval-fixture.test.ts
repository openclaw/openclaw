import fs from "node:fs";
import { afterEach, expect, it, vi, type TestContext } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import * as approvalFixtures from "./exec-approval-manager.test-support.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import {
  createApprovalRequestPolicy,
  createContext,
  createOperatorClient,
  expectSinglePendingApproval as pendingApproval,
  invokeDemoPolicy,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import {
  createApprovalClientLookup,
  waitForApprovalAccepted,
} from "./server-methods/approval-request.test-support.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import {
  requestExecApproval,
  withRequestedExecApproval,
} from "./server-methods/exec-approval.test-support.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams, makeGatewayClient } from "./server-request-context.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

function pluginFixture(test: TestContext, withReviewer = false) {
  const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
  });
  setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
  const { context } = createContext({
    pluginApprovalManager: fixture.manager,
    ...(withReviewer
      ? { getApprovalClientConnIds: createApprovalClientLookup([createOperatorClient()]) }
      : {}),
  });
  const start = () =>
    fixture.track(invokeDemoPolicy(context, withReviewer ? createOperatorClient() : null));
  const observe = () => pendingApproval(fixture.manager, context, start);
  return { ...fixture, context, start, observe };
}

function holdPoint<T = void>() {
  const reached = deferred<T>();
  const released = deferred();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    wait: async (value: T) => {
      reached.resolve(value);
      await released.promise;
    },
  };
}

async function expectHeldRegistration<T>(
  manager: ExecApprovalManager<T>,
  start: () => Promise<{ record: { id: string }; pending: Promise<unknown> }>,
  beforeRelease: () => void,
) {
  const gate = holdPoint();
  const register = manager.register.bind(manager);
  const held = vi.spyOn(manager, "register").mockImplementationOnce(async (...args) => {
    await gate.wait();
    return register(...args);
  });
  const ready = start();
  try {
    await awaitGateBeforeSettlement(gate.reached, ready, "Request ended before registration");
    beforeRelease();
    gate.release();
    const { record, pending } = await ready;
    expect(await manager.resolve(record.id, "deny")).toBe(true);
    await pending;
  } finally {
    gate.release();
    await Promise.allSettled([ready]);
    held.mockRestore();
  }
}

it("prepares the real approval worker before starting a requested request", async (testContext) => {
  const preparation = holdPoint<unknown>();
  const prepare = approvalFixtures.createPreparedTestApprovalManager;
  vi.spyOn(approvalFixtures, "createPreparedTestApprovalManager").mockImplementationOnce(
    async (...args) => {
      const fixture = await prepare(...args);
      await preparation.wait(fixture.manager);
      return fixture;
    },
  );
  const earlyCreate = vi.spyOn(ExecApprovalManager.prototype, "create").mockImplementation(() => {
    throw new Error("Approval record created before worker preparation completed");
  });
  const request = withRequestedExecApproval(
    testContext,
    { request: { id: "prepared-requested", twoPhase: true } },
    async ({ manager, id, requestPromise }) => {
      expect(manager).toBe(await preparation.reached);
      expect(await manager.resolve(id, "deny")).toBe(true);
      await requestPromise;
    },
  );
  const settled = Promise.allSettled([request]);
  try {
    await awaitGateBeforeSettlement(
      preparation.reached,
      request,
      "Request ended before preparation",
    );
    expect(earlyCreate).not.toHaveBeenCalled();
    earlyCreate.mockRestore();
    preparation.release();
    await request;
  } finally {
    preparation.release();
    await settled;
  }
});

it("waits for each real registration before observing broadcastToConnIds", async (testContext) => {
  const { manager, context, run, observe } = pluginFixture(testContext, true);
  context.hasExecApprovalClients = () => true;
  const published = vi.mocked(context.broadcastToConnIds);
  await run(async () => {
    // Reuse the context: the second request must not borrow the first event.
    for (let index = 0; index < 2; index++) {
      await expectHeldRegistration(manager, observe, () =>
        expect(
          published.mock.calls.filter(([event]) => event === "plugin.approval.requested"),
        ).toHaveLength(index),
      );
    }
  });
});

it("does not expose a registered approval before publication", async (testContext) => {
  const { manager, context, run, track, start } = pluginFixture(testContext, true);
  const registration = holdPoint<string>();
  let registeredId: string | undefined;
  const published = deferred();
  const register = manager.register.bind(manager);
  vi.spyOn(manager, "register").mockImplementationOnce(async (record, timeout) => {
    const result = await register(record, timeout);
    registeredId = record.id;
    await registration.wait(record.id);
    return result;
  });
  const publication = vi.mocked(context.broadcastToConnIds);
  publication.mockImplementation((event) => {
    if (event === "plugin.approval.requested") {
      published.resolve();
    }
  });
  await run(async () => {
    vi.useFakeTimers();
    const pending = start();
    try {
      const id = await awaitGateBeforeSettlement(
        registration.reached,
        pending,
        "Approval request completed before registration",
      );
      const readiness = track(
        pendingApproval(manager, context, () => pending).then((result) => {
          expect(publication).toHaveBeenCalled();
          return result;
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(publication).not.toHaveBeenCalled();
      registration.release();
      expect((await readiness).record.id).toBe(id);
    } finally {
      registration.release();
      try {
        if (registeredId !== undefined) {
          await Promise.race([published.promise, pending]);
          expect(await manager.resolve(registeredId, "deny")).toBe(true);
        }
        await pending;
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

it("waits for the real RPC accepted tuple after held registration", async (testContext) => {
  const fixture = createTestApprovalFixture(testContext);
  const { manager } = fixture;
  await fixture.run(async () => {
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const reviewer = makeGatewayClient({
      connId: "fixture-reviewer",
      clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      scopes: ["operator.approvals"],
    });
    const clients = new GatewayClientRegistry([
      {
        ...reviewer,
        usesSharedGatewayAuth: false,
        socket: createGatewayWsTestSocket(),
      },
    ]);
    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.getRuntimeConfig = () => ({});
    const params = { command: "echo fixture", host: "gateway", twoPhase: true, timeoutMs: 60_000 };
    await expectHeldRegistration(
      manager,
      async () => {
        const { pending, response } = await waitForApprovalAccepted(respond, (observedRespond) =>
          fixture.track(
            requestExecApproval({ handlers, params, respond: observedRespond, context }),
          ),
        );
        const [record] = await manager.listPendingRecords();
        expect(response[1]).toMatchObject({ id: record!.id });
        return { pending, record: record! };
      },
      () => expect(respond).not.toHaveBeenCalled(),
    );
  });
});

it("propagates an injected registration rejection before publication", async (testContext) => {
  const { manager, context, run, observe } = pluginFixture(testContext);
  const failure = new Error("registration failed");
  vi.spyOn(manager, "register").mockRejectedValueOnce(failure);
  await expect(run(observe)).rejects.toBe(failure);
  expect(context.broadcast).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

it("joins a late outer handler before releasing its database after an assertion failure", async (testContext) => {
  let joined = false;
  testContext.onTestFinished(() => {
    expect(joined).toBe(true);
    expect(database.db.isOpen).toBe(false);
    expect(fs.existsSync(database.path)).toBe(false);
  });
  const fixture = createTestApprovalFixture(testContext);
  const database = openOpenClawStateDatabase(fixture.databaseOptions);
  const unwinding = holdPoint();
  const failure = new Error("inspection failed");
  let pending: Promise<void> | undefined;
  const body = fixture.run(async () => {
    const record = fixture.manager.create({ command: "echo fixture" }, 60_000);
    await fixture.manager.register(record, 60_000);
    pending = fixture.track(
      (async () => {
        try {
          await fixture.manager.awaitDecision(record.id);
        } catch (error) {
          expect(error).toBeInstanceOf(ApprovalObserverClosedError);
        } finally {
          await unwinding.wait();
          expect(database.db.isOpen).toBe(true);
          joined = true;
        }
      })(),
    );
    throw failure;
  });
  try {
    await awaitGateBeforeSettlement(
      unwinding.reached,
      body,
      "Fixture ended before handler unwound",
    );
    expect(database.db.isOpen).toBe(true);
    unwinding.release();
    await expect(body).rejects.toBe(failure);
    await expect(pending).resolves.toBeUndefined();
    expect(joined).toBe(true);
  } finally {
    unwinding.release();
    await Promise.allSettled([body]);
  }
});
