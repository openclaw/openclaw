import { expect, it, onTestFinished } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";
import type { ChannelApprovalNativeRuntimeAdapterAsync } from "./approval-handler-runtime-types.js";
import { createChannelApprovalHandlerFromCapability as createHandler } from "./approval-handler-runtime.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import { doesApprovalRequestSelectChannelAccountAsync } from "./approval-request-account-binding.js";
import { normalizeApprovalRequest, type ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const HANDLER_PARAMS = {
  label: "test/approval-config",
  clientDisplayName: "Test Approval Handler",
  channel: "test",
  channelLabel: "Test",
};

function createCapability(approvalKind: ChannelApprovalKind) {
  const nativeRuntimeAsync: ChannelApprovalNativeRuntimeAdapterAsync = {
    eventKinds: [approvalKind],
    availability: { isConfigured: () => true, shouldHandle: () => true },
    presentation: {
      buildPendingPayload: () => ({ text: "pending" }),
      buildResolvedResult: () => ({ kind: "leave" }),
      buildExpiredResult: () => ({ kind: "leave" }),
    },
    transport: {
      prepareTarget: () => ({ dedupeKey: "origin-chat", target: { to: "origin-chat" } }),
      deliverPending: () => ({ messageId: "pending" }),
    },
  };
  return {
    native: {
      describeDeliveryCapabilities: (_params: { cfg: OpenClawConfig }) => ({
        enabled: true,
        preferredSurface: "origin" as const,
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: () => ({ to: "origin-chat" }),
    },
    nativeRuntimeAsync,
  };
}

function createGatewayRuntime(getRuntimeConfig: () => OpenClawConfig) {
  const subscribers: Parameters<GatewayNativeApprovalRuntime["subscribe"]>[0][] = [];
  const routeCoordinator = createApprovalNativeRouteCoordinator();
  onTestFinished(() => routeCoordinator.close());
  const runtime = {
    getRuntimeConfig,
    request: async <T>() => [] as T,
    requestRoute: async <T>(): Promise<T> => {
      throw new Error("Unexpected route notice");
    },
    routeCoordinator,
    subscribe: (subscriber: (typeof subscribers)[number]) => {
      subscribers.push(subscriber);
      return () => {};
    },
  } satisfies GatewayNativeApprovalRuntime;
  return { runtime, subscribers };
}

async function requireHandler(params: Parameters<typeof createHandler>[0]) {
  const handler = await createHandler(params);
  if (!handler) {
    throw new Error("Expected approval handler");
  }
  onTestFinished(() => handler.stop());
  return handler;
}

function execRequest(id: string): ExecApprovalRequest {
  return {
    id,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    request: { command: "echo hi", turnSourceChannel: "test", turnSourceTo: "origin-chat" },
  };
}

function pluginRequest(id: string): PluginApprovalRequest {
  return {
    id,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    request: { title: "Plugin approval", description: "Allow the plugin action" },
  };
}

it.for(["exec", "system-agent"] as const)(
  "uses reloaded config and pins an admitted %s request through delivery and resolution",
  async (approvalKind, { signal }) => {
    const initial: OpenClawConfig = { gateway: { publicOrigin: "https://before.example.com" } };
    const admitted: OpenClawConfig = { gateway: { publicOrigin: "https://admitted.example.com" } };
    let current = initial;
    const gateway = createGatewayRuntime(() => current);
    const entered = createDeferred();
    const release = createDeferred();
    const delivered = createDeferred();
    const finalized = createDeferred();
    const deliveries: Array<{ cfg: OpenClawConfig; pendingPayload: unknown }> = [];
    const plannedConfigs: OpenClawConfig[] = [];
    const finalizedConfigs: OpenClawConfig[] = [];
    const capability = createCapability(approvalKind);
    const describeDelivery = capability.native.describeDeliveryCapabilities;
    capability.native.describeDeliveryCapabilities = (params) => {
      plannedConfigs.push(params.cfg);
      return describeDelivery(params);
    };
    capability.nativeRuntimeAsync.presentation.buildPendingPayload = async ({ cfg }) => {
      entered.resolve();
      await release.promise;
      return { text: cfg.gateway?.publicOrigin };
    };
    capability.nativeRuntimeAsync.transport.deliverPending = ({ cfg, pendingPayload }) => {
      deliveries.push({ cfg, pendingPayload });
      return { messageId: "pinned" };
    };
    capability.nativeRuntimeAsync.presentation.buildResolvedResult = ({ cfg }) => {
      finalizedConfigs.push(cfg);
      return { kind: "leave" };
    };
    capability.nativeRuntimeAsync.observe = {
      onDelivered: () => delivered.resolve(),
      onFinalized: () => finalized.resolve(),
    };
    const handler = await withGatewayNativeApprovalRuntime(gateway.runtime, () =>
      requireHandler({ ...HANDLER_PARAMS, capability, cfg: initial }),
    );
    onTestFinished(() => release.resolve());
    current = admitted;
    await handler.start();
    const subscriber = gateway.subscribers[0];
    if (!subscriber) {
      throw new Error("Expected Gateway approval subscription");
    }
    const request = normalizeApprovalRequest(
      approvalKind === "exec"
        ? execRequest("exec:admitted")
        : {
            id: "system-agent:admitted",
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
            request: {
              title: "OpenClaw change",
              description: "Restart Gateway",
              command: "Restart Gateway",
              proposalHash: "a".repeat(64),
              sessionId: "test-session",
              allowedDecisions: ["allow-once", "deny"] as const,
            },
          },
    );
    expect(await subscriber.shouldHandle(request)).toBe(true);
    subscriber.onRequested(request);
    await withinTest(entered.promise, signal);
    current = { gateway: { publicOrigin: "https://later.example.com" } };
    release.resolve();
    await withinTest(delivered.promise, signal);
    await handler.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
    await withinTest(finalized.promise, signal);

    expect(deliveries).toEqual([
      { cfg: admitted, pendingPayload: { text: "https://admitted.example.com" } },
    ]);
    expect(plannedConfigs).toEqual([admitted]);
    expect(finalizedConfigs).toEqual([admitted]);
  },
);

it.each(["exec", "plugin"] as const)(
  "selects the new account after %s forwarding targets hot-apply",
  async (approvalKind) => {
    const configForAccount = (accountId: string): OpenClawConfig => ({
      approvals: {
        [approvalKind]: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "test", accountId, to: "approver" }],
        },
      },
    });
    const initial = configForAccount("first");
    let current = initial;
    const gateway = createGatewayRuntime(() => current);
    const deliveries: string[] = [];
    const handlers = [];
    for (const accountId of ["first", "second"]) {
      const capability = createCapability(approvalKind);
      capability.nativeRuntimeAsync.availability.shouldHandle = ({ cfg, request }) =>
        doesApprovalRequestSelectChannelAccountAsync({
          cfg,
          request,
          channel: "test",
          accountId,
          defaultAccountId: "first",
          eligibleAccountIds: ["first", "second"],
        });
      capability.nativeRuntimeAsync.transport.deliverPending = () => {
        deliveries.push(accountId);
        return { messageId: accountId };
      };
      const handler = await withGatewayNativeApprovalRuntime(gateway.runtime, () =>
        requireHandler({ ...HANDLER_PARAMS, capability, cfg: initial, accountId }),
      );
      await handler.start();
      handlers.push(handler);
    }
    current = configForAccount("second");
    const request =
      approvalKind === "exec"
        ? { ...execRequest("exec:changed-target"), request: { command: "echo hi" } }
        : pluginRequest("plugin:changed-target");
    for (const handler of handlers) {
      await handler.handleRequested(request);
    }
    expect(deliveries).toEqual(["second"]);
  },
);

it("keeps standalone configuration when called in another Gateway scope", async () => {
  const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://standalone.example.com" } };
  const gateway = createGatewayRuntime(() => ({
    gateway: { publicOrigin: "https://unrelated.example.com" },
  }));
  const deliveries: OpenClawConfig[] = [];
  const capability = createCapability("exec");
  capability.nativeRuntimeAsync.transport.deliverPending = ({ cfg: deliveredConfig }) => {
    deliveries.push(deliveredConfig);
    return { messageId: "standalone" };
  };
  const handler = await requireHandler({ ...HANDLER_PARAMS, capability, cfg });
  await withGatewayNativeApprovalRuntime(gateway.runtime, () =>
    handler.handleRequested(execRequest("exec:standalone")),
  );
  expect(deliveries).toEqual([cfg]);
});
