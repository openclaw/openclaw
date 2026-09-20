import { describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { buildRequestedApprovalEvent } from "./approval-shared.js";
import { approveSessionEnvironmentCommand } from "./environments.session-exec-approval.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const binding = {
  environmentId: "worker:preview",
  ownerEpoch: 2,
  generation: 1,
  sessionId: "conversation",
  sessionKey: "agent:main:preview",
  agentId: "main",
};

describe("attached command approval custody", () => {
  it.for([
    { route: "forward", outcome: "allow-once" },
    { route: "ios", outcome: "allow-once" },
    { route: "ios", outcome: "expire" },
    { route: "forward", outcome: "revoke" },
    { route: "all", outcome: "allow-once" },
    { route: "all", outcome: "cron" },
  ] as const)(
    "delivers through $route with ambient caller custody and handles $outcome",
    async ({ route, outcome }, test) => {
      const run = createOperationalRunInstanceRef(`approval-${route}-${outcome}`);
      const authority = claimAgentRunDelegatedAuthority(run);
      test.onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      if (outcome === "cron") {
        test.onTestFinished(
          registerCronRunExecSource(run.runId, {
            agentId: binding.agentId,
            jobId: "fixture-job",
            jobConfigRevision: "fixture-revision",
            jobName: "Fixture automation",
          }),
        );
      }
      const manager = createTestApprovalManager(test, {
        resolveAllowedDecisions: (request: ExecApprovalRequestPayload) =>
          resolveExecApprovalRequestAllowedDecisions(request),
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const delivered = createDeferredCore<ExecApprovalRequest>();
      const forward = vi.fn(async (request: ExecApprovalRequest) => {
        delivered.resolve(request);
        return true;
      });
      const ios = vi.fn<
        NonNullable<
          NonNullable<GatewayRequestContext["execApprovalIosPushDelivery"]>["handleRequested"]
        >
      >(async (request, delivery) => {
        expect(
          delivery?.isTargetVisible?.({
            deviceId: "requester-device",
            scopes: ["operator.approvals"],
          }),
        ).toBe(true);
        expect(
          delivery?.isTargetVisible?.({ deviceId: "other-device", scopes: ["operator.approvals"] }),
        ).toBe(false);
        delivered.resolve(request);
        return true;
      });
      const expired = vi.fn(async () => {});
      const webPush = vi.fn(() => true);
      const context = createGatewayRequestContext(
        makeContextParams({
          execApprovalManager: manager,
          forwardExecApprovalRequest: route !== "ios" ? forward : undefined,
          execApprovalIosPushDelivery: {
            ...(route !== "forward" ? { handleRequested: ios } : {}),
            handleExpired: expired,
          },
          ...(route === "all"
            ? {
                approvalWebPushDelivery: {
                  handleRequested: webPush,
                  handleResolved: async () => {},
                  handleExpired: async () => {},
                },
              }
            : {}),
        }),
      );
      if (outcome === "cron") {
        context.getApprovalClientConnIds = () => new Set(["approval-ui"]);
        context.broadcastToConnIds = (_event, payload, recipients) => {
          expect(recipients).toEqual(new Set(["approval-ui"]));
          expect(payload).toMatchObject({ request: { runId: run.runId } });
          const record = manager.listPendingRecords()[0];
          if (!record) {
            throw new Error("Expected the registered approval before delivery");
          }
          delivered.resolve(buildRequestedApprovalEvent(record, "exec"));
        };
      }
      const client = createSyntheticPluginRuntimeClient({
        pluginRuntimeOwnerId: "crabbox",
        scopes: ["operator.write"],
      });
      client.connId = "requester-connection";
      client.isDeviceTokenAuth = true;
      client.connect.device = {
        id: "requester-device",
        publicKey: "fixture",
        signature: "fixture",
        signedAt: 1,
        nonce: "fixture",
      };
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "attached-approval", method: "environments.session.exec" },
        params: {},
        context,
        client,
        isWebchatConnect: () => false,
        respond: vi.fn(),
      };
      const lifetime = new AbortController();
      await withGatewayToolCallerIdentity(
        {
          agentId: binding.agentId,
          sessionKey: binding.sessionKey,
          operationalRunInstance: run,
          approvalAuthority: authority,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          turnSourceChannel: "telegram",
          turnSourceTo: "fixture-chat",
          turnSourceAccountId: "fixture-account",
          turnSourceThreadId: "fixture-thread",
        },
        async () => {
          const operation = approveSessionEnvironmentCommand({
            options,
            binding,
            argv: ["node", "preview.js"],
            background: true,
            signal: lifetime.signal,
            assertCurrent: () => {
              lifetime.signal.throwIfAborted();
              if (!validateAgentRunDelegatedAuthority(authority)) {
                throw new Error("run authority ended");
              }
            },
          });
          const completion =
            outcome === "allow-once" || outcome === "cron"
              ? expect(operation).resolves.toBeUndefined()
              : expect(operation).rejects.toThrow(
                  outcome === "expire" ? "not approved" : "run authority ended",
                );
          const event = await Promise.race([
            delivered.promise,
            operation.then(() => {
              throw new Error("Approval completed before request delivery");
            }),
          ]);
          expect(event.request).toMatchObject({
            runId: run.runId,
            sessionKey: binding.sessionKey,
            turnSourceChannel: "telegram",
            turnSourceTo: "fixture-chat",
            turnSourceAccountId: "fixture-account",
            turnSourceThreadId: "fixture-thread",
            allowedDecisions: ["allow-once", "deny"],
          });
          expect(manager.listPendingRecords()[0]).toMatchObject({
            requestedByConnId: "requester-connection",
            requestedByDeviceId: "requester-device",
            requestedByDeviceTokenAuth: true,
            agentRuntimeDelegatedAuthority: { ...authority, kind: "local" },
          });
          if (outcome === "expire") {
            manager.expire(event.id);
          } else {
            if (outcome === "revoke") {
              lifetime.abort(new Error("run authority ended"));
              releaseAgentRunDelegatedAuthority(authority);
            }
            manager.resolve(event.id, "allow-once", "reviewer");
          }
          await completion;
          expect(manager.consumeAllowOnce(event.id)).toBe(false);
          if (outcome === "expire") {
            expect(expired).toHaveBeenCalledWith(event);
          }
          if (outcome === "cron") {
            expect(forward).not.toHaveBeenCalled();
            expect(ios).not.toHaveBeenCalled();
            expect(webPush).not.toHaveBeenCalled();
          } else {
            if (route !== "ios") {
              expect(forward).toHaveBeenCalledOnce();
            }
            if (route !== "forward") {
              expect(ios).toHaveBeenCalledOnce();
            }
            if (route === "all") {
              expect(webPush).toHaveBeenCalledOnce();
            }
          }
        },
      );
    },
  );

  for (const decision of ["allow-once", "deny"] as const) {
    it(`shows stdin and honors ${decision} exactly once`, async (test) => {
      const manager = createTestApprovalManager(test, {
        resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      });
      const broadcast = vi.fn((_event: string, request: ExecApprovalRequest) => {
        expect(request.request.command).toContain("script-from-stdin");
        expect(request.request.allowedDecisions).toEqual(["allow-once", "deny"]);
        manager.resolve(request.id, decision, "reviewer");
      });
      const options = {
        client: null,
        context: {
          execApprovalManager: manager,
          broadcast,
          hasExecApprovalClients: () => true,
          logGateway: { error: vi.fn() },
        },
      } as unknown as GatewayRequestHandlerOptions;
      const operation = approveSessionEnvironmentCommand({
        options,
        binding,
        argv: ["node"],
        input: "console.log('script-from-stdin')",
        background: true,
        assertCurrent: () => {},
      });
      if (decision === "allow-once") {
        await expect(operation).resolves.toBeUndefined();
        const id = broadcast.mock.calls[0]![1].id;
        expect(manager.consumeAllowOnce(id)).toBe(false);
      } else {
        await expect(operation).rejects.toThrow("not approved");
      }
    });
  }

  it("refuses approval when the complete command cannot be shown", async (test) => {
    const manager = createTestApprovalManager(test);
    const broadcast = vi.fn();
    const options = {
      client: null,
      context: { execApprovalManager: manager, broadcast },
    } as unknown as GatewayRequestHandlerOptions;
    await expect(
      approveSessionEnvironmentCommand({
        options,
        binding,
        argv: ["node"],
        input: "x".repeat(20_000),
        background: false,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("too large to review");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
