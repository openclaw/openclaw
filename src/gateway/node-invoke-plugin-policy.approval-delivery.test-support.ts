import { expect, it, vi, type TestContext } from "vitest";
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

function deliveryFixture(test: TestContext, delegated = false) {
  const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
    ...(delegated ? { validateAgentRuntimeDelegatedAuthority: () => true } : {}),
  });
  setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
  const { context } = createContext({
    pluginApprovalManager: fixture.manager,
    getApprovalClientConnIds: vi.fn(() => new Set<string>()),
    hasExecApprovalClients: vi.fn(() => false),
  });
  const delivered = createDeferredCore();
  const handleRequested = vi.fn<
    NonNullable<NonNullable<typeof context.pluginApprovalIosPushDelivery>["handleRequested"]>
  >(async () => {
    delivered.resolve();
    return true;
  });
  return {
    ...fixture,
    context,
    handleRequested,
    async request(start = () => invokeDemoPolicy(context, createOperatorClient())) {
      const result = await expectSinglePendingApproval(fixture.manager, context, () =>
        fixture.track(start()),
      );
      await awaitGateBeforeSettlement(
        delivered.promise,
        result.pending,
        "Approval request ended before delivery",
      );
      return result;
    },
  };
}

export function registerNodePolicyApprovalDeliveryTests() {
  it("forwards plugin policy approvals to the originating turn source", async (testContext) => {
    const fixture = deliveryFixture(testContext, true);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      context.forwardPluginApprovalRequest = handleRequested;
      context.validateAgentRuntimeApprovalAuthority = () => true;
      const operationalRunInstance = createOperationalRunInstanceRef("run-node-policy");
      const { record, pending: resultPromise } = await fixture.request(() =>
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
          turnSource: { channel: "tui", to: "terminal", accountId: "default", threadId: 7 },
        }),
      );
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
      expect(handleRequested).toHaveBeenCalledWith(
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
    const fixture = deliveryFixture(testContext);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      context.pluginApprovalIosPushDelivery = { handleRequested };
      const { record, pending: resultPromise } = await fixture.request();

      expect(handleRequested).toHaveBeenCalledTimes(1);
      const deliveryOptions = handleRequested.mock.calls[0]?.[1];
      const visible = (deviceId: string) =>
        deliveryOptions?.isTargetVisible?.({
          deviceId,
          scopes: ["operator.approvals", "operator.read"],
        });
      expect([visible("device-owner"), visible("device-other")]).toEqual([true, false]);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("sends an iOS cleanup wake through the current delivery owner", async (testContext) => {
    const fixture = deliveryFixture(testContext);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      const handleExpired = vi.fn(async () => {});
      context.pluginApprovalIosPushDelivery = { handleRequested, handleExpired };
      const { record, pending: resultPromise } = await fixture.request();
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
