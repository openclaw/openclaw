import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { resolveCoreOperatorGatewayMethodScope } from "./methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { pushHandlers } from "./server-methods/push.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const { sendProfileWebPush } = vi.hoisted(() => ({ sendProfileWebPush: vi.fn() }));
// mock-isolation: Delivery is proven against its owner in event-web-push.profile-send.test.ts.
vi.mock("./event-web-push.js", () => ({ sendProfileWebPush }));

const counts = { sent: 1, failed: 0, skipped: 0, pruned: 0 };
const notification = { profileId: "bob", category: "agent-question", tag: "ticket-42" };

beforeEach(() => {
  sendProfileWebPush.mockReset();
  sendProfileWebPush.mockResolvedValue(counts);
});
afterEach(() => resetTestPluginRegistry());

function notifierPlugin(entitled: boolean) {
  const { registry, config } = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    registry,
    config,
    id: "ticket-notifier",
    name: "Ticket notifier",
    contracts: entitled ? { gatewayMethodDispatch: ["authenticated-request"] } : {},
    register(api) {
      api.registerGatewayMethod(
        "ticketNotifier.assign",
        async ({ respond }) => {
          const result = await dispatchGatewayMethod("push.web.send", notification);
          respond(result.ok, result.payload, result.error);
        },
        { scope: "operator.read", profileAccess: "independent" },
      );
    },
  });
  setTestPluginRegistry(registry.registry);
  const scope = resolveCoreOperatorGatewayMethodScope("push.web.send");
  if (!scope) {
    throw new Error("push.web.send must be an operator-scoped core method");
  }
  const methods = createGatewayMethodRegistry(
    [
      ...registry.registry.gatewayMethodDescriptors,
      {
        name: "push.web.send",
        owner: { kind: "core", area: "push" },
        scope,
        profileAccess: "independent",
        handler: pushHandlers["push.web.send"],
      },
    ],
    registry.registry,
  );
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    getGatewayMethodRegistry: () => methods,
  } as unknown as GatewayRequestContext;
  return (scopes: string[]) =>
    dispatchGatewayRequestInProcessRaw(
      "ticketNotifier.assign",
      {},
      { client: createOperatorWsClient({ scopes }), context, methodRegistry: methods },
    );
}

describe("push.web.send from a plugin request", () => {
  it("sends with the authenticated requester's operator.write scope", async () => {
    const assign = notifierPlugin(true);
    await expect(assign(["operator.read", "operator.write"])).resolves.toMatchObject({
      ok: true,
      payload: counts,
    });
    expect(sendProfileWebPush).toHaveBeenCalledExactlyOnceWith(expect.any(Function), notification);
  });

  it("is forbidden when the requester lacks operator.write", async () => {
    const assign = notifierPlugin(true);
    await expect(assign(["operator.read"])).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCodes.FORBIDDEN, message: "missing scope: operator.write" },
    });
    expect(sendProfileWebPush).not.toHaveBeenCalled();
  });

  it("requires the gatewayMethodDispatch contract", async () => {
    const assign = notifierPlugin(false);
    await expect(assign(["operator.read", "operator.write"])).rejects.toThrow(
      "contracts.gatewayMethodDispatch",
    );
    expect(sendProfileWebPush).not.toHaveBeenCalled();
  });
});
