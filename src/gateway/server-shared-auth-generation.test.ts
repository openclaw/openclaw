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

function proxyClient(
  config: OpenClawConfig,
  identity = "retained@example.test",
  authMethod: "trusted-proxy" | "password" = "trusted-proxy",
): AuthClient {
  const authPolicy = captureGatewayAuthPolicy(config, {
    role: "operator",
    authMethod,
    verifiedIdentity: authMethod === "trusted-proxy" ? identity : undefined,
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

function writeGeneration(
  state: GenerationState,
  generation: string | undefined,
  nextConfig: OpenClawConfig = { gateway: { reload: { mode: "off" } } },
  clients: AuthClient[] = [],
  previous?: OpenClawConfig,
) {
  enforceSharedGatewaySessionGenerationForConfigWrite({
    state,
    nextConfig,
    resolveRuntimeSnapshotGeneration: () => generation,
    clients,
    ...(previous ? { transition: { previous, next: nextConfig } } : {}),
  });
}

afterEach(clearSecretsRuntimeSnapshot);

it.each([
  ["userHeader", proxyConfig({ userHeader: "x-authenticated-user" }), false],
  ["requiredHeaders", proxyConfig({ requiredHeaders: ["x-authenticated"] }), false],
  ["allowLoopback", proxyConfig({ allowLoopback: true }), false],
  ["trustedProxies", proxyConfig({}, ["192.0.2.2"]), false],
  ["explicit all-source revocation", proxyConfig(), true],
] as const)(
  "fences %s while distinguishing handshake changes from source revocation",
  (_field, next, revokeAll) => {
    const initial = proxyConfig();
    const client = proxyClient(initial);
    const state = generationState(client.sharedGatewaySessionGeneration);
    const source = observeSource(state, client);
    const sourceInvalidated = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, sourceInvalidated));
    const nextGeneration = sharedGeneration(next);
    const transition = { previous: initial, next };
    disconnectStaleSharedGatewayAuthClients({
      state,
      clients: [client],
      expectedGeneration: revokeAll ? null : nextGeneration,
      transition,
    });
    if (!revokeAll) {
      expect(state.finalize(claimGeneration(state, nextGeneration), transition)).toBe(true);
      expect(state.finalize(claimGeneration(state, nextGeneration), { previous: next, next })).toBe(
        true,
      );
    }

    expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(client.invalidated).toBe(true);
    expect(Boolean(client.sourceInvalidated)).toBe(revokeAll);
    expect(sourceInvalidated).toHaveBeenCalledTimes(revokeAll ? 1 : 0);
    expect(source.aborted).toBe(revokeAll);
  },
);

it.each(["trusted-proxy", "password"] as const)(
  "revokes only the changed %s grant",
  (authMethod) => {
    const initial = proxyConfig();
    initial.gateway!.auth!.password = "old-local-fallback";
    const next = structuredClone(initial);
    if (authMethod === "password") {
      next.gateway!.auth!.password = "new-local-fallback";
    } else {
      next.gateway!.auth!.trustedProxy!.allowUsers = ["retained@example.test"];
    }
    const retained = proxyClient(initial);
    const removed = proxyClient(initial, "removed@example.test", authMethod);
    const state = generationState(sharedGeneration(initial));
    const retainedSource = observeSource(state, retained);
    const removedSource = observeSource(state, removed);
    const nextGeneration = sharedGeneration(next);
    const invalidated = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(removed, invalidated));
    expect(
      state.finalize(claimGeneration(state, nextGeneration), { previous: initial, next }),
    ).toBe(true);
    expect(removed.socket.close).not.toHaveBeenCalled();
    expect(removedSource.aborted).toBe(true);
    writeGeneration(state, nextGeneration, next, [retained, removed], initial);
    expect(removed.sourceInvalidated).toBe(true);
    expect(removed.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(invalidated).toHaveBeenCalledOnce();
    if (authMethod === "password") {
      expect(nextGeneration).toBe(removed.sharedGatewaySessionGeneration);
      expect(retained.socket.close).not.toHaveBeenCalled();
    }
    expect(retained.sourceInvalidated).toBeFalsy();
    expect(retainedSource.aborted).toBe(false);
  },
);

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
    writeGeneration(state, newer);
  }
  expect(state.finalize(ownership)).toBe(newer === null);
  expect(state).toMatchObject({ current: newer ?? claimed, required: newer });
});

it("rejects a stale restart marker after a newer config write", () => {
  const state = generationState("generation-a");
  const restartOwnership = state.capture();
  writeGeneration(state, "generation-b");

  expect(state.setRequired(restartOwnership, "generation-a")).toBeNull();
  expect(state).toMatchObject({ current: "generation-b", required: "generation-b" });
});
