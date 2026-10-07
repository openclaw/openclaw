import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { PreparedQuestionCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { withSessionPendingInputAuthorityGuard } from "../../config/sessions/session-pending-input-authority.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { isGatewayNativeApprovalMethod } from "../../infra/approval-gateway-runtime-methods.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import { isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import {
  hasPreparedGatewayDeviceAuthority,
  readAcceptedGatewayDeviceSourceAuthority,
  readGatewayDeviceRevocationGuard,
} from "../device-revocation.js";
import type { ExpectedProfileBinding } from "../expected-profile.js";
import { isInternalApprovalCommitGuard } from "../internal-approval-authority.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
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
  /** Preparation checks cannot consume an opaque SDK commit callback. */
  assertPreparationCurrent: () => void;
  questionCallerRead?: PreparedQuestionCallerRead;
  assertCurrent: () => void;
  /** Original transport/SDK lifetime; prepared-profile methods check selection separately. */
  assertLifetimeCurrent: () => void;
  /** Host-proven child input retains its source after the spawning invocation closes. */
  assertAdmittedInputCurrent?: () => void;
  /** Original person restrictions survive independently of the invoking tool receipt. */
  assertOperatorCurrent?: () => void;
  expectedProfileBinding?: ExpectedProfileBinding;
  /** Recorded by the scope owner only when this invocation uses its narrow alternative. */
  sessionScope?: SessionOperatorScope;
};

/** Request lifetime only; method owners retain target and policy checks. */
type GatewayRequestMutationAuthority = RequestMutationAuthorityBase &
  ({ family: "worker"; assertWorkerCurrent: () => void } | { family: "native-compatibility" });

const requestMutationAuthorityKey = Symbol("gatewayRequestMutationAuthority");

class RequestMutationAuthorityBinding {
  readonly #owner: object;
  readonly #authority: GatewayRequestMutationAuthority;

  constructor(owner: object, authority: GatewayRequestMutationAuthority) {
    this.#owner = owner;
    this.#authority = authority;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, owner: object): GatewayRequestMutationAuthority | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#authority
      : undefined;
  }
}

function bindRequestMutationAuthority(
  options: object,
  authority: GatewayRequestMutationAuthority,
): void {
  Object.defineProperty(options, requestMutationAuthorityKey, {
    value: new RequestMutationAuthorityBinding(options, authority),
    configurable: true,
  });
}

function assertRequestTransportCurrent(options: RequestMutationOptions): void {
  options.signal?.throwIfAborted();
  const acceptedSource = readAcceptedGatewayDeviceSourceAuthority(
    options.hasCurrentClientAuthority,
  );
  if (
    (acceptedSource ? !acceptedSource() : options.client?.invalidated) ||
    options.hasCurrentClientAuthority?.() === false
  ) {
    throw new Error("Gateway requester authority changed");
  }
}

function assertRequestAuthorityCurrent(options: RequestMutationOptions): void {
  assertRequestTransportCurrent(options);
  options.sessionMutationCommitGuard?.();
}

function captureRequestAuthorityAssertion(options: RequestMutationOptions) {
  const source = captureExternalSessionCommitGuard(options.sessionMutationCommitGuard);
  return composeSessionSourceAssertion(
    [source],
    (assertSource) => {
      assertRequestTransportCurrent(options);
      assertSource();
    },
    {
      preparedCheck: (assertSource) => {
        options.signal?.throwIfAborted();
        if (!hasPreparedGatewayDeviceAuthority(options.client, options.hasCurrentClientAuthority)) {
          throw new Error("Gateway requester authority changed");
        }
        assertSource();
      },
    },
  );
}

/** Opaque SDK guards retain their synchronous commit boundary from v2026.9.4. */
export function readGatewayRequestMutationAuthority(
  options: RequestMutationOptions,
): GatewayRequestMutationAuthority {
  const binding: unknown = Object.getOwnPropertyDescriptor(
    options,
    requestMutationAuthorityKey,
  )?.value;
  const retained = RequestMutationAuthorityBinding.read(binding, options);
  if (retained) {
    return retained;
  }
  const { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } = options;
  const captured = { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard };
  const assertLifetimeCurrent = captureRequestAuthorityAssertion(captured);
  const compatibility: GatewayRequestMutationAuthority = {
    family: "native-compatibility",
    assertPreparationCurrent: () => assertRequestTransportCurrent(captured),
    assertCurrent: assertLifetimeCurrent,
    assertLifetimeCurrent,
  };
  bindRequestMutationAuthority(options, compatibility);
  return compatibility;
}

/** The in-process owner separates preparation and accepted input from opaque commit callbacks. */
export function bindInProcessRequestMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  assertSourceCurrent: (() => void) | undefined,
  assertPreparationCurrent: (() => void) | undefined,
  questionCallerRead?: PreparedQuestionCallerRead,
): T {
  if (
    isGatewayNativeApprovalMethod(options.req.method) &&
    isInternalApprovalCommitGuard(options.sessionMutationCommitGuard)
  ) {
    const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
      options;
    const assertWorkerCurrent = () => {
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
        sessionMutationCommitGuard,
      });
    };
    bindRequestMutationAuthority(options, {
      family: "worker",
      assertPreparationCurrent: assertWorkerCurrent,
      assertCurrent: assertWorkerCurrent,
      assertLifetimeCurrent: assertWorkerCurrent,
      assertWorkerCurrent,
    });
  }
  if (!assertSourceCurrent && !assertPreparationCurrent && !questionCallerRead) {
    return options;
  }
  const source = readGatewayRequestMutationAuthority(options);
  const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
    options;
  bindRequestMutationAuthority(options, {
    ...source,
    questionCallerRead,
    assertPreparationCurrent: () => {
      source.assertPreparationCurrent();
      assertPreparationCurrent?.();
    },
    ...(assertSourceCurrent
      ? {
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
        }
      : {}),
  });
  return options;
}

/** WS admission retains owner facts, never an arbitrary generation getter or socket lifetime. */
export function bindWebSocketRequestMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  client: GatewayWsClient,
  generationReader: (() => string | undefined) | undefined,
): T {
  const generationState = SharedGatewaySessionGenerationState.fromReader(generationReader);
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
    const acceptedSource = readAcceptedGatewayDeviceSourceAuthority(hasCurrentClientAuthority);
    if (
      options.req !== req ||
      options.client !== client ||
      options.context !== context ||
      options.signal !== signal ||
      options.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
      options.sessionMutationCommitGuard !== undefined ||
      !hasCurrentDeviceRevocation() ||
      client.internal?.agentRuntimeIdentity
    ) {
      throw new Error("Gateway requester authority changed");
    }
    if (acceptedSource) {
      if (!acceptedSource()) {
        throw new Error("Gateway requester authority changed");
      }
      return;
    }
    if (
      client.invalidated ||
      !isGatewayAuthPolicyCurrent(client.authPolicy, getRuntimeConfigSnapshot())
    ) {
      throw new Error("Gateway requester authority changed");
    }
    const requiredGeneration = client.usesSharedGatewayAuth
      ? generationState.requiredGeneration
      : undefined;
    if (
      requiredGeneration !== undefined &&
      client.sharedGatewaySessionGeneration !== requiredGeneration
    ) {
      throw new Error("Gateway requester authority changed");
    }
  };
  bindRequestMutationAuthority(options, {
    family: "worker",
    assertPreparationCurrent: assertWorkerCurrent,
    assertLifetimeCurrent: assertWorkerCurrent,
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
  const assertCurrent = composeSessionSourceAssertion([
    assertHandlerCurrent,
    source.assertOperatorCurrent,
    source.family === "worker" ? source.assertWorkerCurrent : undefined,
    captureRequestAuthorityAssertion(handler),
  ]);
  const assertLifetimeCurrent = composeSessionSourceAssertion(
    [source.assertLifetimeCurrent],
    (assertSource) => {
      assertHandlerCurrent();
      // Keep the pre-router owner; the handler guard also contains native profile selection.
      assertSource();
    },
  );
  const authority: GatewayRequestMutationAuthority = {
    assertPreparationCurrent: () => {
      assertHandlerCurrent();
      source.assertPreparationCurrent();
    },
    questionCallerRead: source.questionCallerRead,
    assertCurrent,
    assertLifetimeCurrent,
    expectedProfileBinding: retainedProfileBinding,
    sessionScope: retainedSessionScope,
    assertOperatorCurrent: source.assertOperatorCurrent,
    ...(source.family === "worker"
      ? {
          family: "worker" as const,
          assertWorkerCurrent: () => {
            assertHandlerCurrent();
            source.assertOperatorCurrent?.();
            source.assertWorkerCurrent();
          },
        }
      : { family: "native-compatibility" as const }),
  };
  if (source.assertAdmittedInputCurrent) {
    const assertAdmittedInputCurrent = source.assertAdmittedInputCurrent;
    const assertTransferredHandlerCurrent = () => {
      assertHandlerCurrent();
      source.assertOperatorCurrent?.();
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
      const admitted = authorization.admittedInputAuthority;
      handler.sessionMutationAuthorization = {
        ...authorization,
        ...(admitted
          ? {
              admittedInputAuthority: withSessionPendingInputAuthorityGuard(
                admitted,
                assertTransferredHandlerCurrent,
              ),
            }
          : {}),
        assertAdmittedInputCurrent: () => {
          assertTransferredHandlerCurrent();
          (authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent)();
        },
      };
    }
  }
  bindRequestMutationAuthority(handler, authority);
  return handler;
}

/** Retain the person's ceiling independently of the request's receipt lifetime. */
export function captureGatewayRequestOperatorGuard(options: GatewayRequestOptions): () => void {
  const { client, context } = options;
  const source = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(client);
  const role = client?.connect?.role ?? "operator";
  const scopes = [...(client?.connect?.scopes ?? [])];
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const canonicalProfileId = client?.preparedSessionProfile?.profileId;
  const assertCurrent = () => {
    source.assertOperatorCurrent?.();
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      (client?.connect?.role ?? "operator") !== role ||
      scopes.some((scope) => !operatorScopeSatisfied(scope, client?.connect?.scopes ?? [])) ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.authenticatedUserId !== userId ||
      (canonicalProfileId !== undefined &&
        client?.preparedSessionProfile?.profileId !== canonicalProfileId) ||
      currentActor?.kind !== actor?.kind ||
      (actor?.kind === "operator" &&
        (currentActor?.kind !== "operator" || currentActor.profileId !== actor.profileId))
    ) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed"),
      );
    }
    if (actor?.kind === "operator") {
      const error = authorizeCurrentOperatorRoleScopes(
        client,
        (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
      );
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    }
  };
  bindRequestMutationAuthority(options, { ...source, assertOperatorCurrent: assertCurrent });
  return assertCurrent;
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
  const assertAdmittedInputCurrent = composeSessionSourceAssertion([
    assertAdmittedSourceCurrent ?? assertCommitAllowed,
    authorization?.assertCurrent,
  ]);
  const admitted = authorization?.admittedInputAuthority;
  return {
    ...authorization,
    ...(authorization?.prepareWorkerGrant
      ? {
          prepareWorkerGrant: async () => {
            assertExpectedProfile?.();
            assertCommitAllowed?.();
            const prepared = await authorization.prepareWorkerGrant!();
            const wrap = (assertSource: () => void) => () => {
              assertExpectedProfile?.();
              assertCommitAllowed?.();
              assertSource();
            };
            return {
              ...prepared,
              assertCurrent: wrap(prepared.assertCurrent),
              assertLifetimeCurrent: wrap(prepared.assertLifetimeCurrent),
            };
          },
        }
      : {}),
    assertAdmittedInputCurrent,
    ...(admitted
      ? {
          admittedInputAuthority: withSessionPendingInputAuthorityGuard(admitted, () =>
            (assertAdmittedSourceCurrent ?? assertCommitAllowed)?.(),
          ),
        }
      : {}),
    ...(authorization?.withCurrent
      ? {
          withCurrent: <T>(consume: () => T) =>
            authorization.withCurrent!(() => {
              assertExpectedProfile?.();
              assertCommitAllowed?.();
              return consume();
            }),
        }
      : {}),
    ...(authorization?.withPreparedCurrent
      ? {
          withPreparedCurrent: <T>(
            facts: Parameters<NonNullable<SessionMutationAuthorization["withPreparedCurrent"]>>[0],
            consume: () => T,
            assertSourceCurrent: () => void,
          ) =>
            authorization.withPreparedCurrent!(
              facts,
              () => {
                assertExpectedProfile?.();
                assertCommitAllowed?.();
                return consume();
              },
              assertSourceCurrent,
            ),
        }
      : {}),
    assertCurrent: composeSessionSourceAssertion([
      assertExpectedProfile,
      assertCommitAllowed,
      authorization?.assertCurrent,
    ]),
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  };
}
