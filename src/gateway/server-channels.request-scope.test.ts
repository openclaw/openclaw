import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  createTestPlugin,
  createTestChannelRegistry,
  createTestChannelManager,
  waitForAbort,
  type TestAccount,
} from "./server-channels.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-authority.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry>;

beforeEach(() => {
  resetGatewayWorkAdmission();
  previousRegistry = getActivePluginRegistry();
});

afterEach(() => {
  resetGatewayWorkAdmission();
  setActivePluginRegistry(previousRegistry ?? createTestChannelRegistry());
});

it.each(["operator client", "agent run", "operator tool"] as const)(
  "keeps channel requests bound to their Gateway after the initiating %s ends",
  async (caller) => {
    const continueChannelRequest = createDeferred();
    const observedGateway = createDeferred<{ gateway: string }>();
    const ownerContext = createContext();
    ownerContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "health",
          scope: "operator.read",
          owner: { kind: "core", area: "channel-startup" },
          handler: ({ respond }: GatewayRequestHandlerOptions) =>
            respond(true, { gateway: "channel-owner" }),
        },
      ]);
    const callerContext = createContext();
    callerContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "health",
          scope: "operator.read",
          owner: { kind: "core", area: "channel-startup" },
          handler: ({ respond }: GatewayRequestHandlerOptions) =>
            respond(true, { gateway: "starting-client" }),
        },
      ]);
    const startAccount = async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
      await continueChannelRequest.promise;
      try {
        observedGateway.resolve(
          await dispatchGatewayMethodInProcess<{ gateway: string }>(
            "health",
            {},
            {
              syntheticScopes: ["operator.read"],
              operatorRoleActor: { kind: "system" },
            },
          ),
        );
      } catch (error) {
        observedGateway.reject(error);
      }
      await waitForAbort(abortSignal);
    };
    setActivePluginRegistry(createTestChannelRegistry(createTestPlugin({ startAccount })));
    const manager = createTestChannelManager({ resolveGatewayContext: () => ownerContext });
    const callerLifetime = new AbortController();

    try {
      await withPluginRuntimeGatewayRequestScope(
        {
          context: callerContext,
          client: createSyntheticPluginRuntimeClient({
            scopes: ["operator.read"],
            operatorRoleActor: { kind: "system" },
          }),
          isWebchatConnect: () => false,
          signal: callerLifetime.signal,
          hasCurrentClientAuthority: () => !callerLifetime.signal.aborted,
        },
        () => {
          const start = () => manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
          if (caller === "agent run") {
            return withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:main",
                operationalRunInstance: { runId: "channel-start", instanceId: "starting-run" },
                receiptAuthority: () => !callerLifetime.signal.aborted,
              },
              start,
            );
          }
          return caller === "operator tool"
            ? withOperatorToolGatewayAuthority(
                { scopes: ["operator.read"], operatorRoleActor: { kind: "system" } },
                start,
              )
            : start();
        },
      );
      callerLifetime.abort();
      const requestResult = expect(observedGateway.promise).resolves.toEqual({
        gateway: "channel-owner",
      });
      continueChannelRequest.resolve();
      await requestResult;
    } finally {
      continueChannelRequest.resolve();
      await manager.stopChannel("discord");
    }
  },
);
