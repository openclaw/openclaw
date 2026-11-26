import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import { getGatewayRequestAuthorityV1 } from "../plugin-sdk/gateway-request-authority.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { makeMockHttpResponse } from "./test-http-response.js";

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
  const generation = "current";
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
  it("preserves each concurrent HTTP caller in a registered RPC and expires the nested lease", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const individual = ensureProfileForEmail("http-caller@example.test");
      const owner = ensureGatewayOwnerProfile(null);
      const { registry, config } = createPluginRegistryFixture();
      const path = "/authority-proof";
      const log = createSubsystemLogger("test/plugin-rpc-authority");
      const warnings = vi.spyOn(log, "warn");
      const retained: NonNullable<ReturnType<typeof getGatewayRequestAuthorityV1>>[] = [];
      registerVirtualTestPlugin({
        registry,
        config,
        id: "authority-proof",
        name: "Authority proof",
        contracts: { gatewayMethodDispatch: ["authenticated-request"] },
        register(api) {
          api.registerGatewayMethod(
            "authorityProof.read",
            async ({ respond }) => {
              const authority = getGatewayRequestAuthorityV1();
              if (authority) {
                await authority.revalidate();
                retained.push(authority);
              }
              respond(true, {
                person: authority?.personProfileId,
                attribution: authority?.attributionProfileId,
              });
            },
            { scope: "operator.read", profileAccess: "independent" },
          );
          api.registerGatewayMethod(
            "authorityProof.forward",
            async ({ respond }) => {
              const result = await dispatchGatewayMethod("authorityProof.read", {});
              respond(result.ok, result.payload, result.error);
            },
            { scope: "operator.read", profileAccess: "independent" },
          );
          api.registerHttpRoute({
            path,
            match: "exact",
            auth: "gateway",
            async handler(_req, res) {
              const nested = await dispatchGatewayMethod("authorityProof.forward", {});
              res.end(JSON.stringify(nested.payload));
              return true;
            },
          });
        },
      });
      const methods = createGatewayMethodRegistry(
        registry.registry.gatewayMethodDescriptors,
        registry.registry,
      );
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        trackExecution: trackAsyncWork,
        getGatewayMethodRegistry: () => methods,
      });
      setTestPluginRegistry(registry.registry);
      const handler = createGatewayPluginRequestHandler({
        registry: registry.registry,
        log,
        getGatewayRequestContext: () => context,
      });
      const results = await Promise.all(
        (["trusted-proxy", "token"] as const).map(async (authMethod) => {
          const profile = authMethod === "trusted-proxy" ? individual : owner;
          const profileId = profile.id;
          const response = makeMockHttpResponse();
          response.res.req.url = path;
          response.res.req.method = "GET";
          await handler(response.res.req, response.res, undefined, {
            gatewayAuthSatisfied: true,
            gatewayRequestOperatorScopes: ["operator.read"],
            gatewayRequestAuth: {
              authMethod,
              trustDeclaredOperatorScopes: false,
              authenticatedUserProfile: {
                profileId,
                displayName: null,
                hasAvatar: false,
                updatedAt: profile.updatedAt,
              },
              ...(authMethod === "trusted-proxy"
                ? { personProfileId: profileId }
                : { operatorRoleActor: { kind: "system" } }),
            },
          });
          return response.end.mock.calls[0]?.[0];
        }),
      );
      expect(results, JSON.stringify(warnings.mock.calls)).toEqual([
        JSON.stringify({ person: individual.id, attribution: individual.id }),
        JSON.stringify({ attribution: owner.id }),
      ]);
      expect(retained).toHaveLength(2);
      for (const authority of retained) {
        expect(() => authority.assertCurrent()).toThrow("Gateway request authority expired");
      }
    });
  });

  it.each(["login", "shared"] as const)(
    "binds individual identity to the %s source for this RPC",
    async (source) => {
      const f = fixture("immediate");
      f.client.internal =
        source === "shared"
          ? { authenticatedOperator: true, operatorRoleActor: { kind: "system" } }
          : { authenticatedOperator: true };
      if (source === "login") {
        f.client.authenticatedUserId = "person@example.test";
      }
      f.client.authenticatedUserProfile = {
        profileId: "visitor-profile",
        displayName: null,
        hasAvatar: false,
        avatarRevision: "1",
        updatedAt: 1,
      };
      let captured: ReturnType<typeof getGatewayRequestAuthorityV1>;
      f.outer.mockImplementationOnce(({ respond }) => {
        captured = getGatewayRequestAuthorityV1();
        captured?.assertCurrent();
        respond(true, {
          person: captured?.personProfileId ?? null,
          attribution: captured?.attributionProfileId,
          scopes: captured?.scopes,
        });
      });
      await f.dispatch();
      const response = await f.harness.awaitResponseFrame("nested");
      expect(response).toMatchObject({
        ok: true,
        payload: {
          person: source === "login" ? "visitor-profile" : null,
          attribution: "visitor-profile",
          scopes: ["operator.read", "operator.write"],
        },
      });
      expect(() => captured?.assertCurrent()).toThrow("Gateway request authority expired");
    },
  );

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

  // Before handler entry, both fence variants exercise the same admission guard.
  describe.each([
    { phase: "outer", fence: "commit" },
    { phase: "authorization", fence: "commit" },
    { phase: "inner", fence: "commit" },
    { phase: "inner", fence: "session" },
  ] as const)("$fence mutation fence after $phase await", ({ phase, fence }) => {
    it("carries request-owned cancellation across the await", async () => {
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
    });
  });
});
