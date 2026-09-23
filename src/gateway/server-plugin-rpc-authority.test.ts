import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

afterEach(() => resetTestPluginRegistry());

type Phase = "outer" | "authorization" | "inner" | "immediate";
type CommitFence = "commit" | "session";

function fixture(
  phase: Phase,
  scopes = ["operator.read", "operator.write"],
  fence: CommitFence = "commit",
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const write = vi.fn();
  const effect = vi.fn<GatewayRequestHandler>(async (options) => {
    if (phase === "inner") {
      entered.resolve();
      await release.promise;
    }
    // Exercise the ordinary mutation owner's final fence, not a test-only liveness check.
    if (fence === "session") {
      options.sessionMutationAuthorization?.assertCurrent();
    } else {
      options.sessionMutationCommitGuard?.();
    }
    write();
    options.respond(true, { written: true });
  });
  const outer = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
    if (phase === "outer") {
      entered.resolve();
      await release.promise;
    }
    const result = await dispatchGatewayMethod("authorityProof.effect", {});
    respond(result.ok, result.payload, result.error);
  });
  const { registry, config } = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    registry,
    config,
    id: "authority-proof",
    name: "Authority proof",
    contracts: { gatewayMethodDispatch: ["authenticated-request"] },
    register(api) {
      api.registerGatewayMethod("authorityProof.outer", outer, {
        scope: "operator.read",
        profileAccess: "independent",
      });
    },
  });
  setTestPluginRegistry(registry.registry);
  const methods = createGatewayMethodRegistry(
    [
      ...registry.registry.gatewayMethodDescriptors,
      {
        name: "authorityProof.effect",
        owner: { kind: "core", area: "authority-proof" },
        scope: "operator.write",
        profileAccess: "required",
        handler: effect,
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
  const client = createOperatorWsClient({ scopes });
  if (phase === "authorization") {
    client.authenticatedGitHubIdentitySync = async () => {
      entered.resolve();
      await release.promise;
      client.authenticatedUserProfile = {
        profileId: "authority-proof",
        displayName: "Authority proof",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      return { profileId: "authority-proof", updatedAt: 1 };
    };
  }
  let generation = "current";
  client.usesSharedGatewayAuth = true;
  client.sharedGatewaySessionGeneration = generation;
  const harness = createDispatchTestHarness({
    buildRequestContext: () => context,
    getRequiredSharedGatewaySessionGeneration: () => generation,
  });
  const dispatch = () =>
    harness.dispatcher.dispatch(
      { type: "req", id: "nested", method: "authorityProof.outer", params: {} },
      client,
    );
  return {
    client,
    context,
    methods,
    dispatch,
    entered,
    release,
    write,
    effect,
    outer,
    harness,
    rotate: () => {
      generation = "rotated";
    },
  };
}

async function waitForPause(f: ReturnType<typeof fixture>, pending: Promise<unknown>) {
  await Promise.race([
    f.entered.promise,
    pending.then(() => {
      throw new Error("Request completed without entering the expected await");
    }),
  ]);
}

describe("registered plugin RPC authority through the real dispatcher", () => {
  it.each([true, false])("enforces the nested target's scope (allowed=%s)", async (allowed) => {
    const f = fixture(
      "immediate",
      allowed ? ["operator.read", "operator.write"] : ["operator.read"],
    );
    await f.dispatch();
    const response = await f.harness.awaitResponseFrame("nested");
    expect(response.ok).toBe(allowed);
    expect(f.write).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(f.effect).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      const nested = f.effect.mock.calls[0]?.[0];
      expect(nested?.client).toBe(f.client);
      expect(nested?.client?.internal?.syntheticClient).not.toBe(true);
      expect(nested?.hasCurrentClientAuthority).toBeTypeOf("function");
      expect(nested?.hasCurrentClientAuthority).toBe(
        f.outer.mock.calls[0]?.[0].hasCurrentClientAuthority,
      );
    } else {
      expect(response.error).toMatchObject({ message: "missing scope: operator.write" });
    }
  });

  describe.each(["commit", "session"] as const)("%s mutation fence", (fence) => {
    it.each([
      { phase: "outer", change: "revoked" },
      { phase: "authorization", change: "revoked" },
      { phase: "inner", change: "revoked" },
      { phase: "outer", change: "rotated" },
      { phase: "authorization", change: "rotated" },
      { phase: "inner", change: "rotated" },
    ] as const)(
      "rejects $change caller authority during $phase await before I/O",
      async ({ phase, change }) => {
        const f = fixture(phase, undefined, fence);
        const pending = f.dispatch();
        try {
          await waitForPause(f, pending);
          if (change === "rotated") {
            f.rotate();
          } else {
            f.client.invalidated = true;
            f.client.invalidatedReason = "device-token-revoked";
          }
        } finally {
          f.release.resolve();
          await pending;
        }
        expect(f.write).not.toHaveBeenCalled();
        expect(f.effect).toHaveBeenCalledTimes(phase === "inner" ? 1 : 0);
        expect(f.harness.close).toHaveBeenCalledWith(
          4001,
          change === "rotated"
            ? "gateway auth changed"
            : "client invalidated: device-token-revoked",
        );
        expect(f.harness.send).not.toHaveBeenCalledWith(
          expect.objectContaining({ id: "nested", ok: true }),
        );
      },
    );

    it.each(["outer", "authorization", "inner"] as const)(
      "carries request-owned cancellation across the %s await",
      async (phase) => {
        const f = fixture(phase, undefined, fence);
        const controller = new AbortController();
        const execution = new AsyncWorkScope();
        const pending = execution.run(() =>
          dispatchGatewayRequestInProcessRaw(
            "authorityProof.outer",
            {},
            {
              client: f.client,
              context: f.context,
              methodRegistry: f.methods,
              signal: controller.signal,
            },
          ),
        );
        // Cancellation returns before the tracked handlers finish. Join them before assertions.
        const rejected = expect(pending).rejects.toThrow("caller cancelled");
        try {
          await waitForPause(f, pending);
          controller.abort(new Error("caller cancelled"));
        } finally {
          f.release.resolve();
          await rejected;
          await execution.drain();
        }
        expect(f.write).not.toHaveBeenCalled();
        expect(f.effect).toHaveBeenCalledTimes(phase === "inner" ? 1 : 0);
        if (phase === "inner") {
          expect(f.effect.mock.calls[0]?.[0].signal).toBe(controller.signal);
        }
      },
    );
  });
});
