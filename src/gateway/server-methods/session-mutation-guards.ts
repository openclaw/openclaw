import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
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
  /** Host-proven child input retains its source after the spawning invocation closes. */
  assertAdmittedInputCurrent?: () => void;
  expectedProfileBinding?: ExpectedProfileBinding;
  /** Recorded by the scope owner only when this invocation uses its narrow alternative. */
  sessionScope?: SessionOperatorScope;
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

/** Only the trusted hosted creation producer can separate its tool receipt from input custody. */
export function bindCreatedInputMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  assertSourceCurrent: (() => void) | undefined,
): T {
  if (!assertSourceCurrent) {
    return options;
  }
  const source = readGatewayRequestMutationAuthority(options);
  const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
    options;
  requestMutationAuthorities.set(options, {
    ...source,
    assertAdmittedInputCurrent: () => {
      if (
        options.req !== req ||
        options.client !== client ||
        options.context !== context ||
        options.signal !== signal ||
        options.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
        options.sessionMutationCommitGuard !== sessionMutationCommitGuard
      ) {
        throw new Error("Gateway requester authority changed");
      }
      assertRequestAuthorityCurrent({
        req,
        client,
        signal,
        hasCurrentClientAuthority,
        sessionMutationCommitGuard: assertSourceCurrent,
      });
    },
  });
  return options;
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
  sessionScope?: SessionOperatorScope,
): T {
  const source = readGatewayRequestMutationAuthority(request);
  const retainedProfileBinding = expectedProfileBinding ?? source.expectedProfileBinding;
  const retainedSessionScope = sessionScope ?? source.sessionScope;
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
          expectedProfileBinding: retainedProfileBinding,
          sessionScope: retainedSessionScope,
          assertWorkerCurrent: () => {
            assertHandlerCurrent();
            source.assertWorkerCurrent();
          },
        }
      : {
          family: "native-compatibility",
          assertCurrent,
          expectedProfileBinding: retainedProfileBinding,
          sessionScope: retainedSessionScope,
        };
  if (source.assertAdmittedInputCurrent) {
    const assertAdmittedInputCurrent = source.assertAdmittedInputCurrent;
    const assertTransferredHandlerCurrent = () => {
      assertHandlerCurrent();
      // An adapter may add an opaque host guard. Only the unchanged producer
      // guard has the known tool-receipt/source split; retain any new guard in full.
      if (sessionMutationCommitGuard !== request.sessionMutationCommitGuard) {
        assertRequestAuthorityCurrent(handler);
      }
    };
    authority.assertAdmittedInputCurrent = () => {
      assertTransferredHandlerCurrent();
      assertAdmittedInputCurrent();
    };
    const authorization = handler.sessionMutationAuthorization;
    if (authorization) {
      const retainedHandler = handler;
      retainedHandler.sessionMutationAuthorization = {
        ...authorization,
        assertAdmittedInputCurrent: () => {
          assertTransferredHandlerCurrent();
          (authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent)();
        },
      };
    }
  }
  requestMutationAuthorities.set(handler, authority);
  return handler;
}

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
  assertExpectedProfile: (() => void) | undefined,
  assertAdmittedSourceCurrent?: () => void,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed && !assertExpectedProfile) {
    return authorization;
  }
  // Committed input keeps its original host and session authority. A later
  // account selection change cannot revoke custody already transferred to it.
  const assertAdmittedInputCurrent = () => {
    (assertAdmittedSourceCurrent ?? assertCommitAllowed)?.();
    authorization?.assertCurrent();
  };
  return {
    ...authorization,
    assertAdmittedInputCurrent,
    assertCurrent: () => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertCurrent();
    },
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  };
}
