import { afterEach, expect, it } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { captureAmbientGatewayOperatorAuthority } from "./operator-invocation-authority.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { createTestPlugin, type TestAccount } from "./server-channels.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  resolveInProcessGatewayDispatch,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";

let manager: ChannelManager | undefined;

afterEach(async () => {
  await manager?.stopChannel("discord").catch(() => {});
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

function installPlugin(startAccount: (ctx: ChannelGatewayContext<TestAccount>) => Promise<void>) {
  const registry = createEmptyPluginRegistry();
  const plugin = createTestPlugin({ startAccount });
  registry.channels.push({ pluginId: plugin.id, source: "test", plugin } as never);
  setActivePluginRegistry(registry);
}

function createManagerForTest() {
  const log = createSubsystemLogger("gateway/server-channels-request-scope-test");
  manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: { discord: log } as never,
    channelRuntimeEnvs: { discord: runtimeForLogger(log) } as unknown as Record<string, RuntimeEnv>,
  });
  return manager;
}

it.each(["operator client", "agent run", "operator tool"] as const)(
  "a channel account outlives its initiating %s without inheriting its authority",
  async (caller) => {
    const context = {} as GatewayRequestContext;
    const resolveGatewayContext = () => context;
    type InboundTurn = {
      scope: PluginRuntimeGatewayRequestScope | undefined;
      ambientAuthority: Promise<unknown>;
      dispatchAuthority: Promise<unknown>;
    };
    let resolveInboundTurn!: (turn: InboundTurn) => void;
    const inboundTurn = new Promise<InboundTurn>((resolve) => {
      resolveInboundTurn = resolve;
    });
    let admitInbound!: () => void;
    const inboundReady = new Promise<void>((resolve) => {
      admitInbound = resolve;
    });
    let callerActive = true;
    installPlugin(async () => {
      void inboundReady.then(() => {
        const scope = getPluginRuntimeGatewayRequestScope();
        resolveInboundTurn({
          scope,
          ambientAuthority: captureAmbientGatewayOperatorAuthority({
            missingBindingError: () => new Error("missing binding"),
          }).then(
            (authority) => ({ authority }),
            (error: unknown) => ({ error }),
          ),
          dispatchAuthority: Promise.resolve()
            .then(() => {
              const resolved = resolveInProcessGatewayDispatch("node.list", {});
              resolved.assertInvocationCurrent();
              resolved.assertContextCurrent();
              return { context: resolved.context };
            })
            .catch((error: unknown) => ({ error })),
        });
      });
    });
    const requestClient = {
      connId: "config-patch-conn",
      connect: { role: "operator", scopes: ["operator.admin"], client: { id: "test" } },
      internal: {},
    } as never;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        ...(caller === "agent run"
          ? {
              operationalRunInstance: {
                runId: "plugin-enable-run",
                instanceId: "plugin-enable-owner",
              },
              receiptAuthority: () => callerActive,
            }
          : {}),
      },
      async () =>
        await withPluginRuntimeGatewayRequestScope(
          {
            context,
            resolveGatewayContext,
            client: caller !== "agent run" ? requestClient : undefined,
            signal: new AbortController().signal,
            hasCurrentClientAuthority: () => callerActive,
            isWebchatConnect: () => false,
          },
          () => {
            const start = () => createManagerForTest().startChannel("discord");
            return caller === "operator tool"
              ? withOperatorToolGatewayAuthority({ scopes: ["operator.admin"] }, start)
              : start();
          },
        ),
    );
    callerActive = false;
    admitInbound();

    const turn = await inboundTurn;
    await expect(turn.dispatchAuthority).resolves.toEqual({ context });
    await expect(turn.ambientAuthority).resolves.toEqual({ authority: {} });
    expect(turn.scope?.resolveGatewayContext?.()).toBe(context);
    expect(turn.scope?.client).toBeUndefined();
    expect(turn.scope?.hasCurrentClientAuthority).toBeUndefined();
    expect(turn.scope?.signal).toBeUndefined();
  },
);
