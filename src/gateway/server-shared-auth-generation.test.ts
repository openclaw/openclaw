import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
  type SharedGatewayAuthClient,
} from "./server-shared-auth-generation.js";
import { onGatewayPolicyClientInvalidated } from "./server/ws-policy-close.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

function proxyConfig(
  policy: Partial<GatewayTrustedProxyConfig> = {},
  trustedProxies = ["192.0.2.1"],
): OpenClawConfig {
  return {
    gateway: {
      trustedProxies,
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["retained@example.test", "removed@example.test"],
          ...policy,
        },
      },
    },
  };
}

function sharedGeneration(config: OpenClawConfig) {
  return resolveSharedGatewaySessionGeneration(
    resolveGatewayAuthForConfig({ config }),
    config.gateway?.trustedProxies,
  );
}

function proxyClient(
  config: OpenClawConfig,
  identity = "retained@example.test",
): SharedGatewayAuthClient {
  return {
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: sharedGeneration(config),
    authPolicy: captureGatewayAuthPolicy(config, {
      role: "operator",
      authMethod: "trusted-proxy",
      verifiedIdentity: identity,
    }),
    socket: { close: vi.fn() },
  };
}

function claimGeneration(
  state: SharedGatewaySessionGenerationState,
  generation: string | undefined,
) {
  const ownership = state.claim(state.capture(), generation);
  if (!ownership) {
    throw new Error("expected generation ownership claim");
  }
  return ownership;
}

describe("shared gateway generation publication", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it.each([
    { field: "userHeader", next: proxyConfig({ userHeader: "x-authenticated-user" }) },
    { field: "requiredHeaders", next: proxyConfig({ requiredHeaders: ["x-authenticated"] }) },
    { field: "allowLoopback", next: proxyConfig({ allowLoopback: true }) },
    { field: "trustedProxies", next: proxyConfig({}, ["192.0.2.2"]) },
  ])(
    "fences $field edits without publishing source invalidation, including a later refresh",
    ({ next }) => {
      const initial = proxyConfig();
      const client = proxyClient(initial);
      const state = new SharedGatewaySessionGenerationState({
        current: client.sharedGatewaySessionGeneration,
        required: null,
      });
      const source = new AbortController();
      const releaseGeneration = state.onInvalidated(
        client.sharedGatewaySessionGeneration,
        () => source.abort(),
        client.authPolicy,
      );
      const sourceInvalidated = vi.fn();
      const releaseClient = onGatewayPolicyClientInvalidated(client, sourceInvalidated);
      const publication = vi.spyOn(state, "publishInvalidation");
      const nextGeneration = sharedGeneration(next);
      const transition = { previous: initial, next };
      const ownership = claimGeneration(state, nextGeneration);

      disconnectStaleSharedGatewayAuthClients({
        state,
        clients: [client],
        expectedGeneration: nextGeneration,
        transition,
      });
      expect(state.finalize(ownership, transition)).toBe(true);
      expect(state.finalize(claimGeneration(state, nextGeneration), { previous: next, next })).toBe(
        true,
      );

      expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
      expect(client.invalidated).toBe(true);
      expect(client.sourceInvalidated).toBeFalsy();
      expect(sourceInvalidated).not.toHaveBeenCalled();
      expect(source.signal.aborted).toBe(false);
      expect(publication).not.toHaveBeenCalled();
      releaseClient();
      releaseGeneration();
    },
  );

  it("revokes only the removed proxy identity, including retained disconnected sources", () => {
    const initial = proxyConfig();
    const retained = proxyClient(initial);
    const removed = proxyClient(initial, "removed@example.test");
    const state = new SharedGatewaySessionGenerationState({
      current: sharedGeneration(initial),
      required: null,
    });
    const retainedSource = new AbortController();
    const removedSource = new AbortController();
    const releaseRetained = state.onInvalidated(
      retained.sharedGatewaySessionGeneration,
      () => retainedSource.abort(),
      retained.authPolicy,
    );
    const releaseRemoved = state.onInvalidated(
      removed.sharedGatewaySessionGeneration,
      () => removedSource.abort(),
      removed.authPolicy,
    );
    const next = proxyConfig({ allowUsers: ["retained@example.test"] });
    const nextGeneration = sharedGeneration(next);

    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: next,
      resolveRuntimeSnapshotGeneration: () => nextGeneration,
      clients: [retained],
      transition: { previous: initial, next },
    });

    expect(retained.sourceInvalidated).toBeFalsy();
    expect(retainedSource.signal.aborted).toBe(false);
    expect(removed.socket.close).not.toHaveBeenCalled();
    expect(removedSource.signal.aborted).toBe(true);
    disconnectStaleSharedGatewayAuthClients({
      state,
      clients: [removed],
      expectedGeneration: nextGeneration,
      transition: { previous: initial, next },
    });
    expect(removed.sourceInvalidated).toBe(true);
    expect(removed.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    releaseRetained();
    releaseRemoved();
  });

  it("keeps explicit all-source revocation independent of proxy policy fencing", () => {
    const initial = proxyConfig();
    const client = proxyClient(initial);
    const state = new SharedGatewaySessionGenerationState({
      current: sharedGeneration(initial),
      required: null,
    });
    const revoked = vi.fn();
    const release = state.onInvalidated(
      client.sharedGatewaySessionGeneration,
      revoked,
      client.authPolicy,
    );
    disconnectStaleSharedGatewayAuthClients({
      state,
      clients: [client],
      expectedGeneration: null,
      transition: { previous: initial, next: initial },
    });
    expect(client.sourceInvalidated).toBe(true);
    expect(revoked).toHaveBeenCalledOnce();
    release();
  });

  it("revokes a rotated local proxy password without revoking the proxy identity", () => {
    const proxy = proxyConfig();
    const initial: OpenClawConfig = {
      ...proxy,
      gateway: {
        ...proxy.gateway,
        auth: { ...proxy.gateway?.auth, password: "old-local-fallback" },
      },
    };
    const next: OpenClawConfig = {
      ...initial,
      gateway: {
        ...initial.gateway,
        auth: { ...initial.gateway?.auth, password: "new-local-fallback" },
      },
    };
    const retained = proxyClient(initial);
    const fallback: SharedGatewayAuthClient = {
      usesSharedGatewayAuth: true,
      sharedGatewaySessionGeneration: sharedGeneration(initial),
      authPolicy: captureGatewayAuthPolicy(initial, { role: "operator", authMethod: "password" }),
      socket: { close: vi.fn() },
    };
    const generation = sharedGeneration(next);
    expect(generation).toBe(fallback.sharedGatewaySessionGeneration);
    const state = new SharedGatewaySessionGenerationState({ current: generation, required: null });
    const retainedSource = new AbortController();
    const detachedFallbackSource = new AbortController();
    const releaseRetained = state.onInvalidated(
      generation,
      () => retainedSource.abort(),
      retained.authPolicy,
    );
    const releaseFallback = state.onInvalidated(
      generation,
      () => detachedFallbackSource.abort(),
      fallback.authPolicy,
    );
    const fallbackInvalidated = vi.fn();
    const releaseClient = onGatewayPolicyClientInvalidated(fallback, fallbackInvalidated);
    const transition = { previous: initial, next };

    expect(state.finalize(claimGeneration(state, generation), transition)).toBe(true);
    expect(detachedFallbackSource.signal.aborted).toBe(true);
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: next,
      resolveRuntimeSnapshotGeneration: () => generation,
      clients: [retained, fallback],
      transition,
    });
    expect(fallback.sourceInvalidated).toBe(true);
    expect(fallback.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(fallbackInvalidated).toHaveBeenCalledOnce();
    expect(retained.socket.close).not.toHaveBeenCalled();
    expect(retained.sourceInvalidated).toBeFalsy();
    expect(retainedSource.signal.aborted).toBe(false);
    releaseClient();
    releaseFallback();
    releaseRetained();
  });

  it("normalizes a matching required marker after a same-generation refresh", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    const snapshot = {
      sourceConfig: {},
      config: {},
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    activateSecretsRuntimeSnapshot(snapshot);
    const publishedRevision = getActiveSecretsRuntimeSnapshotRevision();
    activateSecretsRuntimeSnapshot(snapshot);

    expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(publishedRevision);

    expect(state.finalize(ownership)).toBe(true);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-a",
      required: null,
    });
  });

  it("does not clear a same-generation required marker owned by a newer config write", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-a",
      clients: [],
    });

    expect(state.finalize(ownership)).toBe(false);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-a",
      required: "generation-a",
    });
  });

  it("clears the previous required generation after a credential rotation commits", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-b");

    expect(state.finalize(ownership)).toBe(true);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: null,
    });
  });

  it("does not overwrite a newer published generation", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-b",
      clients: [],
    });

    expect(state.finalize(ownership)).toBe(false);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: "generation-b",
    });
  });

  it("rejects a stale restart marker after a newer config write", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: null,
    });
    const restartOwnership = state.capture();
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-b",
      clients: [],
    });

    expect(state.setRequired(restartOwnership, "generation-a")).toBeNull();
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: "generation-b",
    });
  });
});
