import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import { readGatewayDeviceRevocationGuard } from "../device-revocation.js";
import type { ExpectedProfileBinding } from "../expected-profile.js";
import {
  getRequiredSharedGatewaySessionGeneration,
  getSharedGatewaySessionGenerationReaderState,
} from "../server-shared-auth-generation.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./types.js";

type RequestMutationOptions = Pick<
  GatewayRequestHandlerOptions,
  "req" | "client" | "signal" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
>;

type RequestMutationAuthorityBase = {
  assertCurrent: () => void;
  expectedProfileBinding?: ExpectedProfileBinding;
};

/** Request lifetime only; method owners retain target and policy checks. */
export type GatewayRequestMutationAuthority = RequestMutationAuthorityBase &
  ({ family: "worker"; assertWorkerCurrent: () => void } | { family: "native-compatibility" });

const requestMutationAuthorities = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayRequestMutationAuthorities"),
  () => new WeakMap<object, GatewayRequestMutationAuthority>(),
);

function assertRequestAuthorityCurrent(options: RequestMutationOptions): void {
  options.signal?.throwIfAborted();
  if (options.client?.invalidated || options.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway requester authority changed");
  }
  options.sessionMutationCommitGuard?.();
}

/** Opaque SDK guards retain their synchronous commit boundary from v2026.9.4. */
export function readGatewayRequestMutationAuthority(
  options: RequestMutationOptions,
): GatewayRequestMutationAuthority {
  const retained = requestMutationAuthorities.get(options);
  if (retained) {
    return retained;
  }
  const { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } = options;
  const captured = { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard };
  const compatibility: GatewayRequestMutationAuthority = {
    family: "native-compatibility",
    assertCurrent: () => assertRequestAuthorityCurrent(captured),
  };
  requestMutationAuthorities.set(options, compatibility);
  return compatibility;
}

/** WS admission retains owner facts, never an arbitrary generation getter or socket lifetime. */
export function bindWebSocketRequestMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  client: GatewayWsClient,
  generationReader: (() => string | undefined) | undefined,
): T {
  const generationState = getSharedGatewaySessionGenerationReaderState(generationReader);
  const hasCurrentDeviceRevocation = readGatewayDeviceRevocationGuard(
    options.hasCurrentClientAuthority,
  );
  if (
    !generationState ||
    !hasCurrentDeviceRevocation ||
    client.internal?.agentRuntimeIdentity ||
    options.sessionMutationCommitGuard
  ) {
    return options;
  }
  const { req, context, signal, hasCurrentClientAuthority } = options;
  const assertWorkerCurrent = () => {
    signal?.throwIfAborted();
    if (
      options.req !== req ||
      options.client !== client ||
      options.context !== context ||
      options.signal !== signal ||
      options.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
      options.sessionMutationCommitGuard !== undefined ||
      client.invalidated ||
      !isGatewayAuthPolicyCurrent(client.authPolicyGeneration, getRuntimeConfigSnapshot()) ||
      !hasCurrentDeviceRevocation() ||
      client.internal?.agentRuntimeIdentity
    ) {
      throw new Error("Gateway requester authority changed");
    }
    const requiredGeneration = client.usesSharedGatewayAuth
      ? getRequiredSharedGatewaySessionGeneration(generationState)
      : undefined;
    if (
      requiredGeneration !== undefined &&
      client.sharedGatewaySessionGeneration !== requiredGeneration
    ) {
      throw new Error("Gateway requester authority changed");
    }
  };
  requestMutationAuthorities.set(options, {
    family: "worker",
    assertCurrent: () => {
      assertWorkerCurrent();
      assertRequestAuthorityCurrent(options);
    },
    assertWorkerCurrent,
  });
  return options;
}

/** Transfer only this exact invocation's custody after the router composes profile selection. */
export function bindGatewayRequestHandlerMutationAuthority<T extends GatewayRequestHandlerOptions>(
  request: GatewayRequestOptions,
  handler: T,
  expectedProfileBinding: ExpectedProfileBinding | undefined,
): T {
  const source = readGatewayRequestMutationAuthority(request);
  const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
    handler;
  const assertHandlerCurrent = () => {
    if (
      handler.req !== req ||
      handler.client !== client ||
      handler.context !== context ||
      handler.signal !== signal ||
      handler.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
      handler.sessionMutationCommitGuard !== sessionMutationCommitGuard
    ) {
      throw new Error("Gateway requester authority changed");
    }
  };
  const assertCurrent = () => {
    assertHandlerCurrent();
    if (source.family === "worker") {
      source.assertWorkerCurrent();
    }
    assertRequestAuthorityCurrent(handler);
  };
  const authority: GatewayRequestMutationAuthority =
    source.family === "worker"
      ? {
          family: "worker",
          assertCurrent,
          expectedProfileBinding,
          assertWorkerCurrent: () => {
            assertHandlerCurrent();
            source.assertWorkerCurrent();
          },
        }
      : { family: "native-compatibility", assertCurrent, expectedProfileBinding };
  requestMutationAuthorities.set(handler, authority);
  return handler;
}

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
  assertExpectedProfile: (() => void) | undefined,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed && !assertExpectedProfile) {
    return authorization;
  }
  // Committed input keeps its original host and session authority. A later
  // account selection change cannot revoke custody already transferred to it.
  const assertAdmittedInputCurrent = () => {
    assertCommitAllowed?.();
    authorization?.assertCurrent();
  };
  return {
    ...authorization,
    assertAdmittedInputCurrent,
    assertCurrent: () => {
      assertExpectedProfile?.();
      assertAdmittedInputCurrent();
    },
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  };
}
