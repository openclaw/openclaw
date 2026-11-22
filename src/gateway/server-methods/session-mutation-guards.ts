import type { PreparedQuestionCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { withSessionPendingInputAuthorityGuard } from "../../config/sessions/session-pending-input-authority.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { isGatewayWorkerApprovalMethod } from "../../infra/approval-gateway-runtime-methods.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import { readGatewayDeviceRevocationGuard } from "../device-revocation.js";
import type { ExpectedProfileBinding } from "../expected-profile.js";
import { isInternalApprovalCommitGuard } from "../internal-approval-authority.js";
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
  expectedProfileBinding?: ExpectedProfileBinding;
  /** Recorded by the scope owner only when this invocation uses its narrow alternative. */
  sessionScope?: SessionOperatorScope;
};

/** Request lifetime only; method owners retain target and policy checks. */
type GatewayRequestMutationAuthority = RequestMutationAuthorityBase &
  ({ family: "worker"; assertWorkerCurrent: () => void } | { family: "native-compatibility" });

const requestMutationAuthorities = new WeakMap<object, GatewayRequestMutationAuthority>();

function bindRequestMutationAuthority(
  options: object,
  authority: GatewayRequestMutationAuthority,
): void {
  requestMutationAuthorities.set(options, authority);
}

/** Request lifetime only: Stop and the caller's own commit callback; admission checked authority. */
export function readGatewayRequestMutationAuthority(
  options: RequestMutationOptions,
): GatewayRequestMutationAuthority {
  const retained = requestMutationAuthorities.get(options);
  if (retained) {
    return retained;
  }
  const { client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } = options;
  const assertNotAborted = () => signal?.throwIfAborted();
  const assertLifetimeCurrent = composeSessionSourceAssertion(
    [captureExternalSessionCommitGuard(sessionMutationCommitGuard)],
    (assertSource) => {
      assertNotAborted();
      assertSource();
    },
  );
  const lifetime = {
    assertPreparationCurrent: assertNotAborted,
    assertCurrent: assertLifetimeCurrent,
    assertLifetimeCurrent,
  };
  // Device-attested requests without an SDK commit callback are host-owned workers.
  const authority: GatewayRequestMutationAuthority =
    !sessionMutationCommitGuard &&
    !client?.internal?.agentRuntimeIdentity &&
    readGatewayDeviceRevocationGuard(hasCurrentClientAuthority)
      ? { ...lifetime, family: "worker", assertWorkerCurrent: assertNotAborted }
      : {
          ...lifetime,
          family: "native-compatibility",
          ...(sessionMutationCommitGuard
            ? { assertAdmittedInputCurrent: sessionMutationCommitGuard }
            : {}),
        };
  bindRequestMutationAuthority(options, authority);
  return authority;
}

/** The in-process owner separates preparation and accepted input from opaque commit callbacks. */
export function bindInProcessRequestMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  assertSourceCurrent: (() => void) | undefined,
  assertPreparationCurrent: (() => void) | undefined,
  questionCallerRead?: PreparedQuestionCallerRead,
): T {
  const { signal } = options;
  const commitGuard: SessionSourceAssertion | undefined = options.sessionMutationCommitGuard;
  if (
    isGatewayWorkerApprovalMethod(options.req.method) &&
    isInternalApprovalCommitGuard(commitGuard)
  ) {
    const assertWorkerCurrent = () => {
      signal?.throwIfAborted();
      commitGuard?.();
    };
    bindRequestMutationAuthority(options, {
      family: "worker",
      assertPreparationCurrent: assertWorkerCurrent,
      assertCurrent: assertWorkerCurrent,
      assertLifetimeCurrent: assertWorkerCurrent,
      assertWorkerCurrent,
    });
  } else if (
    (!commitGuard || commitGuard.prepareSessionSource) &&
    (!options.hasCurrentClientAuthority ||
      readGatewayDeviceRevocationGuard(options.hasCurrentClientAuthority))
  ) {
    const assertLifetimeCurrent = composeSessionSourceAssertion([commitGuard], (assertSource) => {
      signal?.throwIfAborted();
      assertSource();
    });
    bindRequestMutationAuthority(options, {
      family: "worker",
      assertPreparationCurrent: () => signal?.throwIfAborted(),
      assertCurrent: assertLifetimeCurrent,
      assertLifetimeCurrent,
      // Worker routing must retain the complete in-process guard at commit.
      assertWorkerCurrent: assertLifetimeCurrent,
    });
  }
  if (!assertSourceCurrent && !assertPreparationCurrent && !questionCallerRead) {
    return options;
  }
  const source = readGatewayRequestMutationAuthority(options);
  bindRequestMutationAuthority(options, {
    ...source,
    questionCallerRead,
    assertPreparationCurrent: () => {
      source.assertPreparationCurrent();
      assertPreparationCurrent?.();
    },
    ...(assertSourceCurrent
      ? {
          assertAdmittedInputCurrent: assertSourceCurrent,
        }
      : {}),
  });
  return options;
}

/** Bind router invocation checks separately from the source retained by accepted input. */
export function bindGatewayRequestHandlerMutationAuthority<T extends GatewayRequestHandlerOptions>(
  request: GatewayRequestOptions,
  handler: T,
  expectedProfileBinding: ExpectedProfileBinding | undefined,
  sessionScope?: SessionOperatorScope,
  assertInvocationCurrent?: SessionSourceAssertion,
): T {
  const source = readGatewayRequestMutationAuthority(request);
  const retainedProfileBinding = expectedProfileBinding ?? source.expectedProfileBinding;
  const retainedSessionScope = sessionScope ?? source.sessionScope;
  const transportGuard = handler.sessionMutationCommitGuard;
  if (assertInvocationCurrent) {
    handler.sessionMutationCommitGuard = composeSessionSourceAssertion([
      assertInvocationCurrent,
      captureExternalSessionCommitGuard(transportGuard),
    ]);
  }
  const { signal } = handler;
  const assertCurrent = composeSessionSourceAssertion(
    [
      source.family === "worker" ? source.assertWorkerCurrent : undefined,
      captureExternalSessionCommitGuard(handler.sessionMutationCommitGuard),
    ],
    (assertSources) => {
      signal?.throwIfAborted();
      assertSources();
    },
  );
  const authority: GatewayRequestMutationAuthority = {
    assertPreparationCurrent: source.assertPreparationCurrent,
    questionCallerRead: source.questionCallerRead,
    assertCurrent,
    assertLifetimeCurrent: source.assertLifetimeCurrent,
    expectedProfileBinding: retainedProfileBinding,
    sessionScope: retainedSessionScope,
    ...(source.family === "worker"
      ? { family: "worker" as const, assertWorkerCurrent: source.assertWorkerCurrent }
      : { family: "native-compatibility" as const }),
  };
  if (source.assertAdmittedInputCurrent) {
    const assertAdmittedInputCurrent = source.assertAdmittedInputCurrent;
    const assertTransferredHandlerCurrent = () => {
      // Retain an adapter's explicit host fence, not the submitting transport or permissions.
      if (transportGuard !== request.sessionMutationCommitGuard) {
        transportGuard?.();
      }
    };
    authority.assertAdmittedInputCurrent = () => {
      assertTransferredHandlerCurrent();
      assertAdmittedInputCurrent();
    };
    const authorization = handler.sessionMutationAuthorization;
    if (authorization) {
      const admitted = authorization.admittedInputAuthority;
      const assertAdmittedSourceCurrent = authorization.assertAdmittedSourceCurrent;
      handler.sessionMutationAuthorization = {
        ...authorization,
        ...(assertAdmittedSourceCurrent
          ? {
              assertAdmittedSourceCurrent: () => {
                assertTransferredHandlerCurrent();
                assertAdmittedSourceCurrent();
              },
            }
          : {}),
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

/** Forwarded chat input owns both its target and original request authority. */
export function retainForwardedSessionMutationAuthorization(
  authorization: SessionMutationAuthorization,
  source: SessionMutationAuthorization | undefined,
): SessionMutationAuthorization {
  let releaseSource = source?.retain?.();
  if (!releaseSource) {
    return authorization;
  }
  return {
    ...authorization,
    release: () => {
      try {
        authorization.release?.();
      } finally {
        releaseSource?.();
        releaseSource = undefined;
      }
    },
    takeRelease: () => {
      const releaseAuthorization = authorization.takeRelease?.() ?? authorization.release;
      const releaseRetainedSource = releaseSource;
      releaseSource = undefined;
      return () => {
        try {
          releaseAuthorization?.();
        } finally {
          releaseRetainedSource?.();
        }
      };
    },
  };
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
  // Accepted input keeps its target and explicit host lifetime, not the
  // submitting request's permission or transport checks.
  const assertAdmittedInputCurrent = composeSessionSourceAssertion([
    assertAdmittedSourceCurrent,
    authorization?.assertAdmittedInputCurrent ?? authorization?.assertCurrent,
  ]);
  const admitted = authorization?.admittedInputAuthority;
  const withCommitGuards = <T>(consume: () => T): T => {
    assertExpectedProfile?.();
    assertCommitAllowed?.();
    return consume();
  };
  return {
    ...authorization,
    assertAdmittedSourceCurrent: composeSessionSourceAssertion([
      assertAdmittedSourceCurrent,
      authorization?.assertAdmittedSourceCurrent,
    ]),
    ...(authorization?.prepareWorkerGrant
      ? {
          prepareWorkerGrant: async (target) => {
            const prepared = await withCommitGuards(() =>
              authorization.prepareWorkerGrant!(target),
            );
            const wrap =
              <Args extends unknown[]>(assertSource: (...args: Args) => void) =>
              (...args: Args) =>
                withCommitGuards(() => assertSource(...args));
            return {
              ...prepared,
              assertCurrent: wrap(prepared.assertCurrent),
              assertLifetimeCurrent: wrap(prepared.assertLifetimeCurrent),
              ...(prepared.transaction
                ? {
                    transaction: {
                      ...prepared.transaction,
                      assertCurrent: wrap(prepared.transaction.assertCurrent),
                    },
                  }
                : {}),
            };
          },
        }
      : {}),
    assertAdmittedInputCurrent,
    ...(admitted
      ? {
          admittedInputAuthority: assertAdmittedSourceCurrent
            ? withSessionPendingInputAuthorityGuard(admitted, assertAdmittedSourceCurrent)
            : admitted,
        }
      : {}),
    ...(authorization?.withCurrent
      ? {
          withCurrent: <T>(consume: () => T) =>
            authorization.withCurrent!(() => withCommitGuards(consume)),
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
              () => withCommitGuards(consume),
              assertSourceCurrent,
            ),
        }
      : {}),
    assertCurrent: composeSessionSourceAssertion([
      assertExpectedProfile,
      assertCommitAllowed,
      authorization?.assertCurrent,
    ]),
    assertTargetCurrent: (target) =>
      withCommitGuards(() => authorization?.assertTargetCurrent(target)),
  };
}
