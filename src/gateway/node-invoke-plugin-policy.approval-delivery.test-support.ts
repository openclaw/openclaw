import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createApprovalRequestPolicy,
  createContext,
  createNodeSession,
  createOperatorClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  expectApprovalResolution,
  expectSinglePendingApproval,
  invokeDemoPolicy,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";

function deliveryContext(
  manager: ReturnType<typeof createTestApprovalFixture<PluginApprovalRequestPayload>>["manager"],
) {
  setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
  return createContext({
    pluginApprovalManager: manager,
    getApprovalClientConnIds: vi.fn(() => new Set<string>()),
    hasExecApprovalClients: vi.fn(() => false),
  }).context;
}

function waitForDelivery(delivered: Promise<void>, result: Promise<unknown>) {
  return awaitGateBeforeSettlement(delivered, result, "Approval request ended before delivery");
}

export function registerNodePolicyApprovalDeliveryTests() {
  it("forwards plugin policy approvals to the originating turn source", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const delivered = createDeferredCore();
      const handlePluginApprovalRequested = vi.fn(async () => {
        delivered.resolve();
        return true;
      });
      const context = deliveryContext(manager);
      context.forwardPluginApprovalRequest = handlePluginApprovalRequested;
      context.validateAgentRuntimeApprovalAuthority = () => true;
      const operationalRunInstance = createOperationalRunInstanceRef("run-node-policy");
      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () =>
          fixture.track(
            applyPluginNodeInvokePolicy({
              context,
              client: {
                ...createOperatorClient(),
                internal: {
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: "agent:main:telegram:direct:alice",
                    operationalRunInstance,
                    delegatedAuthority: {
                      kind: "local",
                      operationalRunInstance,
                      lifecycleGeneration: "test-generation",
                      claimId: "test-claim",
                    },
                  },
                },
              },
              nodeSession: createNodeSession(),
              command: DEMO_COMMAND,
              params: DEMO_PARAMS,
              sessionKey: "agent:main:spoofed",
              turnSource: {
                channel: "tui",
                to: "terminal",
                accountId: "default",
                threadId: 7,
              },
            }),
          ),
      );
      await waitForDelivery(delivered.promise, resultPromise);
      expect(record.request).toMatchObject({
        turnSourceChannel: "tui",
        turnSourceTo: "terminal",
        turnSourceAccountId: "default",
        turnSourceThreadId: 7,
      });
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: record.id }),
        new Set<string>(),
        { dropIfSlow: true },
      );
      expect(handlePluginApprovalRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: record.id,
          request: expect.objectContaining({
            turnSourceChannel: "tui",
            turnSourceTo: "terminal",
            turnSourceAccountId: "default",
            turnSourceThreadId: 7,
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:alice",
          }),
        }),
      );

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("delivers plugin policy approvals to visible iOS reviewers", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const delivered = createDeferredCore();
      const context = deliveryContext(manager);
      const handleRequested = vi.fn<
        NonNullable<NonNullable<typeof context.pluginApprovalIosPushDelivery>["handleRequested"]>
      >(async () => {
        delivered.resolve();
        return true;
      });
      context.pluginApprovalIosPushDelivery = { handleRequested };

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await waitForDelivery(delivered.promise, resultPromise);

      expect(handleRequested).toHaveBeenCalledTimes(1);
      const deliveryOptions = handleRequested.mock.calls[0]?.[1];
      expect(
        deliveryOptions?.isTargetVisible?.({
          deviceId: "device-owner",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(true);
      expect(
        deliveryOptions?.isTargetVisible?.({
          deviceId: "device-other",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(false);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("sends an iOS cleanup wake through the current delivery owner", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const delivered = createDeferredCore();
      const handleExpired = vi.fn(async () => {});
      const context = deliveryContext(manager);
      context.pluginApprovalIosPushDelivery = {
        handleRequested: vi.fn(async () => {
          delivered.resolve();
          return true;
        }),
        handleExpired,
      };

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await waitForDelivery(delivered.promise, resultPromise);
      const replacementExpired = vi.fn(async () => {});
      context.pluginApprovalIosPushDelivery = { handleExpired: replacementExpired };
      await manager.expire(record.id, "timeout");

      await expect(resultPromise).resolves.toStrictEqual({
        ok: true,
        payload: { id: record.id, decision: null },
      });
      expect(handleExpired).not.toHaveBeenCalled();
      expect(replacementExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
      expect(replacementExpired.mock.contexts).toEqual([context.pluginApprovalIosPushDelivery]);
    });
  });
}
