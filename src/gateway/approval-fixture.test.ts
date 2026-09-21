import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import {
  createApprovalClientLookup,
  createApprovalRequestPolicy,
  createContext,
  createOperatorClient,
  expectSinglePendingApproval,
  invokeDemoPolicy,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import {
  waitForApprovalAccepted,
  waitForApprovalRequested,
} from "./server-methods/approval-request.test-support.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams, makeGatewayClient } from "./server-request-context.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

describe("approval fixture request ownership", () => {
  it.for(["broadcast", "broadcastToConnIds"] as const)(
    "waits for each real registration before observing %s",
    async (transport, testContext) => {
      const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
        approvalKind: "plugin",
      });
      const { manager } = fixture;
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        hasExecApprovalClients: () => true,
        ...(transport === "broadcastToConnIds"
          ? { getApprovalClientConnIds: createApprovalClientLookup([createOperatorClient()]) }
          : {}),
      });
      const published = vi.mocked(context[transport]);
      const register = manager.register.bind(manager);
      await fixture.run(async () => {
        // Reuse the context: the second request must not borrow the first event.
        for (let index = 0; index < 2; index++) {
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const held = vi.spyOn(manager, "register").mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return register(...args);
          });
          let settled = false;
          const ready = expectSinglePendingApproval(manager, context, () =>
            fixture.track(invokeDemoPolicy(context, createOperatorClient())),
          );
          void ready.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          try {
            await Promise.race([entered.promise, ready]);
            expect(settled).toBe(false);
            expect(
              published.mock.calls.filter(([event]) => event === "plugin.approval.requested"),
            ).toHaveLength(index);
            release.resolve();
            const { record, pending } = await ready;
            expect(await manager.resolve(record.id, "deny")).toBe(true);
            await pending;
          } finally {
            release.resolve();
            await Promise.allSettled([ready]);
            held.mockRestore();
          }
        }
      });
    },
  );

  it("waits for the real RPC accepted tuple after held registration", async (testContext) => {
    const fixture = createTestApprovalFixture(testContext);
    const { manager } = fixture;
    const register = manager.register.bind(manager);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = vi.spyOn(manager, "register").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return register(...args);
    });
    await fixture.run(async () => {
      const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
      const respond = vi.fn();
      const reviewer = makeGatewayClient({
        connId: "fixture-reviewer",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        scopes: ["operator.approvals"],
      });
      const context = Object.assign(
        createGatewayRequestContext(
          makeContextParams({
            clients: new Set([
              {
                ...reviewer,
                usesSharedGatewayAuth: false,
                socket: {
                  ...reviewer.socket,
                  bufferedAmount: 0,
                  send: vi.fn(),
                  terminate: vi.fn(),
                  on: vi.fn(),
                  off: vi.fn(),
                  once: vi.fn(),
                },
              },
            ]),
          }),
        ),
        { getRuntimeConfig: () => ({}) },
      );
      const params = {
        command: "echo fixture",
        host: "gateway",
        twoPhase: true,
        timeoutMs: 60_000,
      };
      let settled = false;
      const ready = waitForApprovalAccepted(respond, (observedRespond) =>
        fixture.track(
          Promise.resolve(
            handler({
              req: { type: "req", method: "exec.approval.request", id: "fixture", params },
              params,
              client: null,
              isWebchatConnect: () => false,
              respond: observedRespond,
              context,
            }),
          ),
        ),
      );
      void ready.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await Promise.race([entered.promise, ready]);
        expect(respond).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        release.resolve();
        const { pending, response } = await ready;
        const [record] = await manager.listPendingRecords();
        expect(response[1]).toMatchObject({ id: record!.id });
        expect(await manager.resolve(record!.id, "deny")).toBe(true);
        await pending;
      } finally {
        release.resolve();
        await Promise.allSettled([ready]);
        held.mockRestore();
      }
    });
  });

  it("propagates an injected registration rejection before publication", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const failure = new Error("registration failed");
    const held = vi.spyOn(fixture.manager, "register").mockRejectedValueOnce(failure);
    const { context } = createContext({ pluginApprovalManager: fixture.manager });
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    try {
      await expect(
        fixture.run(async () => {
          await expectSinglePendingApproval(fixture.manager, context, () =>
            fixture.track(invokeDemoPolicy(context)),
          );
        }),
      ).rejects.toBe(failure);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      held.mockRestore();
    }
  });

  it("rejects request completion without a new publication and restores the context", async () => {
    const { context } = createContext();
    const broadcast = context.broadcast;
    broadcast("plugin.approval.requested", { id: "previous-request" });
    await expect(
      waitForApprovalRequested(context, "plugin.approval.requested", async () => {}),
    ).rejects.toThrow("Approval request completed before the expected RPC event");
    expect(context.broadcast).toBe(broadcast);
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
    const unwinding = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("inspection failed");
    let settled = false;
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
            unwinding.resolve();
            await release.promise;
            expect(database.db.isOpen).toBe(true);
            joined = true;
          }
        })(),
      );
      throw failure;
    });
    void body.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([unwinding.promise, body]);
      expect(settled).toBe(false);
      expect(database.db.isOpen).toBe(true);
      release.resolve();
      await expect(body).rejects.toBe(failure);
      await expect(pending).resolves.toBeUndefined();
      expect(joined).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([body]);
    }
  });
});
