import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
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

export function registerNodePolicyApprovalDeliveryTests() {
  it("forwards plugin policy approvals to the originating turn source", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const getApprovalClientConnIds = vi.fn(() => new Set<string>());
      const delivered = createDeferredCore();
      const handlePluginApprovalRequested = vi.fn(async () => {
        delivered.resolve();
        return true;
      });
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds,
        hasExecApprovalClients: vi.fn(() => false),
        forwardPluginApprovalRequest: handlePluginApprovalRequested,
        validateAgentRuntimeApprovalAuthority: () => true,
      });
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
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);
      expect(record.request.turnSourceChannel).toBe("tui");
      expect(record.request.turnSourceTo).toBe("terminal");
      expect(record.request.turnSourceAccountId).toBe("default");
      expect(record.request.turnSourceThreadId).toBe(7);
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
      const handleRequested = vi.fn(
        async (
          _request: PluginApprovalRequest,
          _opts?: {
            isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
          },
        ) => {
          delivered.resolve();
          return true;
        },
      );
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds: vi.fn(() => new Set<string>()),
        hasExecApprovalClients: vi.fn(() => false),
        pluginApprovalIosPushDelivery: { handleRequested },
      });

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);

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
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds: vi.fn(() => new Set<string>()),
        hasExecApprovalClients: vi.fn(() => false),
        pluginApprovalIosPushDelivery: {
          handleRequested: vi.fn(async () => {
            delivered.resolve();
            return true;
          }),
          handleExpired,
        },
      });

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);
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
