import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  SharedGatewaySessionGenerationState as GenerationState,
  type SharedGatewayAuthClient as AuthClient,
} from "./server-shared-auth-generation.js";
import { makePreparedSecretsSnapshot } from "./server-startup-config.test-support.js";
import { onGatewayPolicyClientInvalidated } from "./server/ws-policy-close.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

function generationState(current: string | undefined, required: string | null = null) {
  return new GenerationState({ current, required });
}

function observeSource(state: GenerationState, client: AuthClient) {
  const source = new AbortController();
  onTestFinished(
    state.onInvalidated(
      client.sharedGatewaySessionGeneration,
      () => source.abort(),
      client.authPolicy,
    ),
  );
  return source.signal;
}

function proxyConfig(
  policy: Partial<GatewayTrustedProxyConfig> = {},
  trustedProxies = ["192.0.2.1"],
): OpenClawConfig {
  const trustedProxy = {
    userHeader: "x-forwarded-user",
    allowUsers: ["retained@example.test", "removed@example.test"],
    ...policy,
  };
  return { gateway: { trustedProxies, auth: { mode: "trusted-proxy", trustedProxy } } };
}

function sharedGeneration(config: OpenClawConfig) {
  return resolveSharedGatewaySessionGeneration(
    resolveGatewayAuthForConfig({ config }),
    config.gateway?.trustedProxies,
  );
}

function proxyClient(config: OpenClawConfig, identity = "retained@example.test"): AuthClient {
  const authPolicy = captureGatewayAuthPolicy(config, {
    role: "operator",
    authMethod: "trusted-proxy",
    verifiedIdentity: identity,
  });
  return {
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: sharedGeneration(config),
    authPolicy,
    socket: { close: vi.fn() },
  };
}

function claimGeneration(state: GenerationState, generation: string | undefined) {
  return expectDefined(state.claim(state.capture(), generation), "generation ownership claim");
}

afterEach(clearSecretsRuntimeSnapshot);

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
    const state = generationState(client.sharedGatewaySessionGeneration);
    const source = observeSource(state, client);
    const sourceInvalidated = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, sourceInvalidated));
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
    expect(source.aborted).toBe(false);
    expect(publication).not.toHaveBeenCalled();
  },
);

it("revokes only the removed proxy identity, including retained disconnected sources", () => {
  const initial = proxyConfig();
  const retained = proxyClient(initial);
  const removed = proxyClient(initial, "removed@example.test");
  const state = generationState(sharedGeneration(initial));
  const retainedSource = observeSource(state, retained);
  const removedSource = observeSource(state, removed);
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
  expect(retainedSource.aborted).toBe(false);
  expect(removed.socket.close).not.toHaveBeenCalled();
  expect(removedSource.aborted).toBe(true);
  disconnectStaleSharedGatewayAuthClients({
    state,
    clients: [removed],
    expectedGeneration: nextGeneration,
    transition: { previous: initial, next },
  });
  expect(removed.sourceInvalidated).toBe(true);
  expect(removed.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
});

it("keeps explicit all-source revocation independent of proxy policy fencing", () => {
  const initial = proxyConfig();
  const client = proxyClient(initial);
  const state = generationState(sharedGeneration(initial));
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
  const initial = proxyConfig();
  initial.gateway!.auth!.password = "old-local-fallback";
  const next = structuredClone(initial);
  next.gateway!.auth!.password = "new-local-fallback";
  const retained = proxyClient(initial);
  const fallback: AuthClient = {
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: sharedGeneration(initial),
    authPolicy: captureGatewayAuthPolicy(initial, { role: "operator", authMethod: "password" }),
    socket: { close: vi.fn() },
  };
  const generation = sharedGeneration(next);
  expect(generation).toBe(fallback.sharedGatewaySessionGeneration);
  const state = generationState(generation);
  const retainedSource = observeSource(state, retained);
  const detachedFallbackSource = observeSource(state, fallback);
  const fallbackInvalidated = vi.fn();
  const releaseClient = onGatewayPolicyClientInvalidated(fallback, fallbackInvalidated);
  const transition = { previous: initial, next };

  expect(state.finalize(claimGeneration(state, generation), transition)).toBe(true);
  expect(detachedFallbackSource.aborted).toBe(true);
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
  expect(retainedSource.aborted).toBe(false);
  releaseClient();
});

it.each([
  ["same-generation refresh", "generation-a", null, true],
  ["credential rotation", "generation-b", null, false],
  ["newer same-generation write", "generation-a", "generation-a", false],
  ["newer rotated generation", "generation-a", "generation-b", false],
] as const)("finalizes only the current owner after %s", (_name, claimed, newer, refresh) => {
  const state = generationState("generation-a", "generation-a");
  const ownership = claimGeneration(state, claimed);
  if (refresh) {
    const snapshot = makePreparedSecretsSnapshot({});
    activateSecretsRuntimeSnapshot(snapshot);
    const publishedRevision = getActiveSecretsRuntimeSnapshotRevision();
    activateSecretsRuntimeSnapshot(snapshot);
    expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(publishedRevision);
  }
  if (newer) {
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => newer,
      clients: [],
    });
  }
  expect(state.finalize(ownership)).toBe(newer === null);
  expect(state).toMatchObject({ current: newer ?? claimed, required: newer });
});

it("rejects a stale restart marker after a newer config write", () => {
  const state = generationState("generation-a");
  const restartOwnership = state.capture();
  enforceSharedGatewaySessionGenerationForConfigWrite({
    state,
    nextConfig: { gateway: { reload: { mode: "off" } } },
    resolveRuntimeSnapshotGeneration: () => "generation-b",
    clients: [],
  });

  expect(state.setRequired(restartOwnership, "generation-a")).toBeNull();
  expect(state).toMatchObject({ current: "generation-b", required: "generation-b" });
});
