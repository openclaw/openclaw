import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { getGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type Delivery = Pick<ChannelOutboundContext, "to" | "text" | "accountId">;

async function checkApprovalForwarding() {
  const capturedRuntime = createDeferred<GatewayNativeApprovalRuntime>();
  const deliveries: Delivery[] = [];
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "telegram" }),
    config: {
      listAccountIds: () => ["default", "ops"],
      defaultAccountId: (cfg) => cfg.channels?.telegram?.defaultAccount ?? "default",
      resolveAccount: (_cfg, accountId) => ({ accountId }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    approvalCapability: {
      delivery: { shouldSuppressForwardingFallback: () => true },
    },
    messaging: { normalizeTarget: (target) => target },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, accountId }) => {
        deliveries.push({ to, text, accountId });
        return { channel: "telegram", messageId: `approval-message-${deliveries.length}` };
      },
    },
    gateway: {
      startAccount: async ({ abortSignal }) => {
        capturedRuntime.resolve(
          expectDefined(getGatewayNativeApprovalRuntime(), "channel Gateway approval runtime"),
        );
        await waitForAbortSignal(abortSignal);
      },
    },
  };
  setTestPluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
  const cfg: OpenClawConfig = {
    gateway: { mode: "local", reload: { mode: "off" } },
    channels: {
      telegram: {
        enabled: true,
        defaultAccount: "ops",
        healthMonitor: { enabled: false },
        execApprovals: { enabled: true, approvers: ["123"], target: "channel" },
        accounts: { default: {}, ops: {} },
      },
    },
    approvals: { plugin: { enabled: true, mode: "session" } },
  };
  await writeConfigFile(cfg);
  const sessionKey = "agent:main:telegram:direct:123";
  testState.sessionStorePath = path.join(resolveStateDir(), "approval-forwarding", "sessions.json");
  await writeSessionStore({
    entries: {
      [sessionKey]: {
        sessionId: "approval-forwarding-session",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "default",
      },
    },
  });
  const gateway = await createGatewaySuiteHarness({ serverOptions: { bind: "loopback" } });
  const reporters: ReturnType<
    GatewayNativeApprovalRuntime["routeCoordinator"]["createReporter"]
  >[] = [];
  let otherGateway: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
  try {
    await gateway.server.startupSettled;
    const ws = await gateway.openWs();
    await connectOk(ws, { scopes: ["operator.admin"] });
    // Minimal Gateways skip account autostart; use the registered lifecycle owner.
    for (const accountId of ["default", "ops"]) {
      const started = await rpcReq(ws, "channels.start", { channel: "telegram", accountId });
      expect(started.ok).toBe(true);
    }
    const nativeRuntime = await withTestTimeout(
      capturedRuntime.promise,
      5_000,
      "channel account did not receive its Gateway approval runtime",
    );
    function registerNativeRoute(runtime: GatewayNativeApprovalRuntime, accountId: string) {
      const reporter = runtime.routeCoordinator.createReporter({
        handledKinds: new Set(["plugin"]),
        channel: "telegram",
        accountId,
        requestGateway: async () => {
          throw new Error("the route fixture must not dispatch notices");
        },
        shouldHandle: () => true,
        classifyRoute: () => "unbound",
      });
      reporter.start();
      reporters.push(reporter);
      return reporter;
    }

    async function expectApprovalDelivery(
      title: string,
      forwarded: boolean,
      turnSourceChannel = "telegram",
    ) {
      const response = await rpcReq<{ id: string; status: string }>(ws, "plugin.approval.request", {
        pluginId: "approval-test",
        sessionKey,
        title,
        description: "Confirm the requested operation.",
        turnSourceChannel,
        turnSourceTo: "123",
        turnSourceAccountId: "default",
        twoPhase: true,
        timeoutMs: 60_000,
      });
      expect(response.ok).toBe(true);
      const { id, status } = expectDefined(response.payload, "pending approval response");
      const prompts = () => deliveries.filter((delivery) => delivery.text.includes(title));
      try {
        expect(status).toBe("accepted");
        if (forwarded) {
          await vi.waitFor(() => expect(prompts()).not.toHaveLength(0), { timeout: 5_000 });
        }
      } finally {
        const resolved = await rpcReq(ws, "plugin.approval.resolve", {
          id,
          decision: "deny",
        });
        expect(resolved.ok).toBe(true);
        expect((await waitForGatewayActiveWork(5_000)).drained).toBe(true);
      }
      expect(prompts()).toHaveLength(forwarded ? 1 : 0);
      if (forwarded) {
        expect(prompts()[0]).toMatchObject({
          to: "123",
          text: expect.stringContaining(id),
          accountId: turnSourceChannel === "telegram" ? "default" : undefined,
        });
      }
    }
    await expectApprovalDelivery("No native handler", true);
    const defaultRoute = registerNativeRoute(nativeRuntime, "default");
    await expectApprovalDelivery("Matching native handler", false);
    await defaultRoute.stop();
    await expectApprovalDelivery("Native handler stopped", true);

    await writeConfigFile({
      ...cfg,
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    });
    defaultRoute.start();
    await expectApprovalDelivery("Destination defaults to ops", true, "discord");
    const opsRoute = registerNativeRoute(nativeRuntime, "ops");
    await expectApprovalDelivery("Destination native handler", false, "discord");
    await opsRoute.stop();
    otherGateway = createGatewayInstanceRuntime({
      getContext: () => {
        throw new Error("the other Gateway must not receive requests");
      },
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    registerNativeRoute(otherGateway.nativeApprovals, "ops");
    await expectApprovalDelivery("Other Gateway native handler", true, "discord");
  } finally {
    await Promise.all(reporters.map((reporter) => reporter.stop()));
    otherGateway?.close();
    await gateway.server.close({ drainTimeoutMs: 0 });
    resetTestPluginRegistry();
  }
}

it("uses the owning native runtime and destination account for approval forwarding", () =>
  withEnvAsync(
    { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
    checkApprovalForwarding,
  ));
