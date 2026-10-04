import { expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.test-fixtures.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

type NodeDuplexAuthorityFixture = {
  registry: PluginRegistry;
  gatewayRequestScopeModule: Pick<
    typeof import("../plugins/runtime/gateway-request-scope.js"),
    | "withPluginRuntimeRegistryScope"
    | "withPluginRuntimePluginScope"
    | "withPluginRuntimeGatewayRequestScope"
  >;
  setGatewayContext: (context: GatewayRequestContext) => void;
  setDispatch: (handler: (options: GatewayRequestOptions) => Promise<void>) => void;
  createRuntime: () => PluginRuntime;
  getLastDispatchedParams: () => Record<string, unknown> | undefined;
};

/** Registers authority cases under the existing plugin loader's shared lifecycle. */
export function registerNodeDuplexAuthoritySuite(setup: () => NodeDuplexAuthorityFixture): void {
  test.each([false, true])(
    "revalidates caller-prepared facts after pending node approval: stale=%s",
    async (stale) => {
      const {
        registry,
        gatewayRequestScopeModule,
        setGatewayContext,
        setDispatch,
        createRuntime,
        getLastDispatchedParams,
      } = setup();
      const nodeRegistry = new NodeRegistry();
      const sendInvokeInput = vi
        .spyOn(nodeRegistry, "sendInvokeInput")
        .mockImplementation(() => {});
      setGatewayContext(createGatewayRequestContext(makeContextParams({ nodeRegistry })));
      const waiting = createDeferredCore();
      const approve = createDeferredCore();
      const finish = createDeferredCore();
      const delivered = vi.fn();
      let current = true;
      setDispatch(async (opts: GatewayRequestOptions) => {
        const stream = opts.client!.internal!.nodeInvokeStream!;
        waiting.resolve();
        await approve.promise;
        if (!stream.isRuntimeCurrent()) {
          opts.respond(false, undefined, {
            code: "ABORTED",
            message: "prepared selection retired",
          });
          return;
        }
        delivered();
        stream.onDispatchReady("prepared-selection");
        stream.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
        await finish.promise;
        opts.respond(true, { ok: true });
      });
      const runtime = createRuntime();
      const opening = gatewayRequestScopeModule.withPluginRuntimeRegistryScope(registry, () =>
        gatewayRequestScopeModule.withPluginRuntimePluginScope(
          { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
          () =>
            runtime.nodes.openDuplex({
              nodeId: "node-1",
              command: "image.bridge",
              assertCurrent() {
                if (!current) {
                  throw new Error("prepared selection retired");
                }
              },
            }),
        ),
      );
      void opening.catch(() => {});
      await waiting.promise;
      expect(getLastDispatchedParams()).not.toHaveProperty("assertCurrent");
      current = !stale;
      approve.resolve();
      if (stale) {
        await expect(opening).rejects.toThrow("prepared selection retired");
        expect(delivered).not.toHaveBeenCalled();
      } else {
        const channel = await opening;
        expect(delivered).toHaveBeenCalledOnce();
        current = false;
        await expect(channel.send(Uint8Array.of(1))).rejects.toThrow("prepared selection retired");
        expect(sendInvokeInput).not.toHaveBeenCalled();
        finish.resolve();
        await expect(channel.closed).rejects.toThrow("prepared selection retired");
      }
      finish.resolve();
    },
  );

  test("cancels a retained duplex invocation when its delegated caller authority closes", async () => {
    const { registry, gatewayRequestScopeModule, setGatewayContext, setDispatch, createRuntime } =
      setup();
    const nodeRegistry = new NodeRegistry();
    const sendInvokeInput = vi.spyOn(nodeRegistry, "sendInvokeInput").mockImplementation(() => {});
    const validateAgentRuntimeApprovalAuthority = vi.fn(() => true);
    const context = createGatewayRequestContext(
      makeContextParams({ nodeRegistry, validateAgentRuntimeApprovalAuthority }),
    );
    setGatewayContext(context);
    let invokeSignal: AbortSignal | undefined;
    setDispatch(async (opts: GatewayRequestOptions) => {
      invokeSignal = opts.signal;
      opts.client?.internal?.nodeInvokeStream?.onDispatchReady("delegated-duplex");
      opts.client?.internal?.nodeInvokeStream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const operationalRunInstance = {
      instanceId: "delegated-instance",
      runId: "delegated-run",
    };
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal = {
      ...client.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:delegated",
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          lifecycleGeneration: "delegated-generation",
          claimId: "delegated-claim",
          operationalRunInstance,
        },
      },
    };
    const requestScope = {
      context,
      client,
      isWebchatConnect: () => false,
      pluginRegistry: registry,
    } satisfies PluginRuntimeGatewayRequestScope;
    const runtime = createRuntime();
    const channel = await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(
      requestScope,
      () =>
        gatewayRequestScopeModule.withPluginRuntimePluginScope(
          { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
          () => runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
        ),
    );

    validateAgentRuntimeApprovalAuthority.mockReturnValue(false);

    await expect(channel.send(Uint8Array.of(1))).rejects.toThrow(/authority.*no longer current/i);
    expect(invokeSignal?.aborted).toBe(true);
    expect(sendInvokeInput).not.toHaveBeenCalled();
    await expect(channel.closed).rejects.toThrow(/authority.*no longer current/i);
    expect(() => channel.onMessage(vi.fn())).toThrow(/authority.*no longer current/i);
  });
}
