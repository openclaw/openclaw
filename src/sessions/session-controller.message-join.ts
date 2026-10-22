import {
  prepareReplyToolAuthorityCallerRead,
  recordPreparedToolAuthorityRead,
  type ReplyToolAuthorityContinuation,
} from "../agents/harness/host-private-capabilities.js";
import { resolveRequesterPrincipalKey } from "../agents/requester-origin.js";
import { resolveModelFallbackOptions } from "../auto-reply/reply/agent-runner-run-params.js";
import {
  MessageInjectionPolicyMismatchError,
  MessageInjectionTargetUnavailableError,
} from "../auto-reply/reply/message-injection-authority.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { prepareFollowupRunToolAuthorityFingerprint } from "../auto-reply/reply/reply-tool-authority.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  type ReplyToolAuthorityOverlay,
} from "./session-controller.contracts.js";

/** Prepare current caller policy against this captured execution, without rebuilding that execution. */
export async function prepareReplyMessageContinuation(params: {
  target: ReplyMessageInjectionTarget;
  input: ReplyToolAuthorityContinuation;
  assertCurrent: () => void;
}) {
  const owner = params.target[replyMessageInjectionTargetOwner];
  const provenance = params.input.caller.inputProvenance;
  if (provenance && provenance.kind !== "external_user") {
    // Peer/delegated input retains its own admission; matching requester identity is insufficient.
    return { kind: "unsupported" as const };
  }
  const principal = resolveRequesterPrincipalKey({
    ...params.input.caller,
    messageChannel: params.input.caller.originatingChannel,
  });
  if (!principal || principal !== owner.requesterPrincipalKey) {
    return { kind: "unsupported" as const };
  }
  const fingerprint = owner.toolAuthorityFingerprint;
  if (!fingerprint) {
    return { kind: "unsupported" as const };
  }
  const assertOwner = () => {
    params.assertCurrent();
    if (!fingerprint || owner.toolAuthorityFingerprint !== fingerprint) {
      throw new MessageInjectionTargetUnavailableError("Reply steering authority changed");
    }
  };
  assertOwner();
  try {
    const caller = await prepareReplyToolAuthorityCallerRead(
      owner.projectToolAuthorityFingerprintAsync,
      params.input,
      fingerprint,
      undefined,
      assertOwner,
    );
    assertOwner();
    if (!caller) {
      // Released snapshots keep their existing complete-policy compatibility path.
      return { kind: "unsupported" as const };
    }
    await caller.prepareCurrent();
    assertOwner();
    params.input.delivery.assertCurrent();
    const retained = caller.retainCurrent();
    const assertCurrent = () => {
      assertOwner();
      retained.assertCurrent();
      params.input.delivery.assertCurrent();
    };
    return {
      kind: "prepared" as const,
      fingerprint,
      read: () => {
        assertCurrent();
        return fingerprint;
      },
      prepareCurrent: async () => {
        assertCurrent();
        await caller.prepareCurrent();
        await params.input.delivery.prepareCurrent();
        assertCurrent();
        recordPreparedToolAuthorityRead({
          ...caller,
          assertLegacyCurrent: assertCurrent,
        });
      },
      release: () => retained.release(),
    };
  } catch (error) {
    params.assertCurrent();
    if (error instanceof MessageInjectionTargetUnavailableError) {
      return { kind: "deferred" as const, reason: "reply-owner-ended" as const };
    }
    assertOwner();
    if (error instanceof MessageInjectionPolicyMismatchError) {
      return { kind: "deferred" as const, reason: error.reason };
    }
    throw error;
  }
}

/** One selected owner decides whether current input can join or needs separate-turn custody. */
export async function prepareReplyMessageJoin(params: {
  followupRun: FollowupRun;
  operation: ReplyOperation;
  target: ReplyMessageInjectionTarget;
  assertCurrent: () => void;
  continuation?: ReplyToolAuthorityContinuation;
  collaborativeCaller?: ReplyToolAuthorityOverlay;
}) {
  const { followupRun, operation, target, assertCurrent } = params;
  const requesterMismatch = hasReplySteeringRequesterMismatch(followupRun, operation);
  if (params.continuation && !requesterMismatch) {
    const joined = await prepareReplyMessageContinuation({
      target,
      input: params.continuation,
      assertCurrent,
    });
    if (joined.kind === "deferred") {
      return joined;
    }
    if (joined.kind === "prepared") {
      return {
        kind: "prepared" as const,
        toolAuthority: joined,
        toolAuthorityFingerprint: joined.fingerprint,
        automaticFallbackRoute: undefined,
        pendingInputAuthorityFingerprint: undefined,
        collaborativeCaller: undefined,
        prepareCurrent: joined.prepareCurrent,
      };
    }
  }
  const legacy = await prepareLegacyReplySteeringAuthority(
    followupRun,
    operation,
    assertCurrent,
    params.collaborativeCaller,
  );
  if (legacy.shouldQueueAuthorityMismatch) {
    legacy.toolAuthority.release();
    return {
      kind: "deferred" as const,
      reason: legacy.requesterMismatch
        ? ("requester-mismatch" as const)
        : ("tool_authority_mismatch" as const),
    };
  }
  return {
    kind: "prepared" as const,
    toolAuthority: legacy.toolAuthority,
    toolAuthorityFingerprint: legacy.toolAuthorityFingerprint,
    automaticFallbackRoute: legacy.automaticFallbackRoute,
    pendingInputAuthorityFingerprint: legacy.pendingInputAuthorityFingerprint,
    collaborativeCaller: legacy.collaborativeCaller,
    prepareCurrent: async () => {
      legacy.toolAuthority.read();
    },
  };
}

/** Keep selection changes separate from the concrete route and its effective tool authority. */
async function prepareLegacyReplySteeringAuthority(
  followupRun: FollowupRun,
  operation: ReplyOperation | undefined,
  assertCurrent: () => void = () => {},
  collaborativeCaller?: ReplyToolAuthorityOverlay,
) {
  const requesterMismatch = hasReplySteeringRequesterMismatch(followupRun, operation);
  const activeFingerprint = operation?.toolAuthorityFingerprint;
  const activeRoute = operation?.toolAuthorityRoute;
  const incoming = await prepareFollowupRunToolAuthorityFingerprint(
    followupRun,
    undefined,
    assertCurrent,
  );
  let atActiveRoute: typeof incoming | undefined;
  let retained: typeof incoming | undefined;
  try {
    const incomingFingerprint = incoming.read();
    atActiveRoute = activeRoute
      ? await prepareFollowupRunToolAuthorityFingerprint(followupRun, activeRoute, assertCurrent)
      : undefined;
    const incomingAtActiveRoute = atActiveRoute?.read();
    assertCurrent();
    if (operation?.result || operation?.abortSignal.aborted) {
      // Losing the target returns valid incoming input to follow-up custody.
      retained = incoming;
      return {
        toolAuthority: incoming,
        toolAuthorityFingerprint: incomingFingerprint,
        automaticFallbackRoute: undefined,
        pendingInputAuthorityFingerprint: undefined,
        collaborativeCaller: undefined,
        requesterMismatch,
        shouldQueueAuthorityMismatch: true,
      };
    }
    if (
      operation &&
      (operation.toolAuthorityRoute !== activeRoute ||
        operation.toolAuthorityFingerprint !== activeFingerprint)
    ) {
      throw new Error("Reply steering authority changed during preparation");
    }
    const authorityMismatch = operation !== undefined && activeFingerprint !== incomingFingerprint;
    const routeOnlyMismatch =
      !requesterMismatch &&
      authorityMismatch &&
      activeFingerprint !== undefined &&
      incomingAtActiveRoute === activeFingerprint;
    const selectedRoute = operation?.requestedToolAuthorityRoute;
    const selectionChanged =
      selectedRoute !== undefined &&
      (selectedRoute.provider !== followupRun.run.provider ||
        selectedRoute.model !== followupRun.run.model);
    const activeRouteDiffers =
      activeRoute !== undefined &&
      (activeRoute.provider !== followupRun.run.provider ||
        activeRoute.model !== followupRun.run.model);
    const fallbackRoute = operation?.automaticFallbackRoute;
    const fallbackSelection =
      routeOnlyMismatch || (collaborativeCaller && activeRouteDiffers)
        ? resolveModelFallbackOptions(followupRun.run).modelFallbackAvailability
        : undefined;
    const compatibleFallbackRoute =
      selectedRoute !== undefined &&
      !selectionChanged &&
      fallbackSelection?.kind !== "disabled_by_model_override" &&
      fallbackSelection?.kind !== "disabled_by_model_selection_lock" &&
      fallbackRoute?.provider === activeRoute?.provider &&
      fallbackRoute?.model === activeRoute?.model
        ? fallbackRoute
        : undefined;
    if (
      operation &&
      collaborativeCaller &&
      !selectionChanged &&
      (!activeRouteDiffers || compatibleFallbackRoute !== undefined) &&
      activeFingerprint &&
      (requesterMismatch || authorityMismatch)
    ) {
      const caller = { ...collaborativeCaller, allowCollaborativeSteering: true as const };
      const projected = await operation.projectToolAuthorityFingerprintAsync(caller);
      assertCurrent();
      if (
        operation.toolAuthorityRoute !== activeRoute ||
        operation.toolAuthorityFingerprint !== activeFingerprint
      ) {
        throw new Error("Reply steering authority changed during preparation");
      }
      if (projected === activeFingerprint) {
        return {
          toolAuthority: {
            read: () => {
              assertCurrent();
              if (operation.result || operation.abortSignal.aborted) {
                throw new MessageInjectionTargetUnavailableError(
                  "Reply steering target is no longer running",
                );
              }
              const current = operation.projectToolAuthorityFingerprint(caller);
              if (!current) {
                throw new Error("Reply steering authority is no longer current");
              }
              return current;
            },
            release() {},
          },
          toolAuthorityFingerprint: activeFingerprint,
          automaticFallbackRoute: compatibleFallbackRoute,
          pendingInputAuthorityFingerprint: undefined,
          collaborativeCaller,
          requesterMismatch,
          shouldQueueAuthorityMismatch: false,
        };
      }
    }
    const automaticFallbackRoute = routeOnlyMismatch ? compatibleFallbackRoute : undefined;
    retained = automaticFallbackRoute && atActiveRoute ? atActiveRoute : incoming;
    return {
      toolAuthority: retained,
      toolAuthorityFingerprint: automaticFallbackRoute
        ? (incomingAtActiveRoute ?? incomingFingerprint)
        : incomingFingerprint,
      automaticFallbackRoute,
      pendingInputAuthorityFingerprint: routeOnlyMismatch ? activeFingerprint : undefined,
      collaborativeCaller: undefined,
      requesterMismatch,
      shouldQueueAuthorityMismatch:
        requesterMismatch || selectionChanged || (authorityMismatch && !routeOnlyMismatch),
    };
  } finally {
    if (retained !== incoming) {
      incoming.release();
    }
    if (atActiveRoute && retained !== atActiveRoute) {
      atActiveRoute.release();
    }
  }
}

/** Strict steering and question responses require the execution's authenticated requester. */
export function hasReplySteeringRequesterMismatch(
  followupRun: FollowupRun,
  operation: ReplyOperation | undefined,
): boolean {
  const requesterPrincipalKey = resolveRequesterPrincipalKey({
    ...followupRun.run,
    messageChannel: followupRun.originatingChannel,
    operatorAuthority: followupRun.operatorAuthority,
  });
  return (
    followupRun.currentInboundEventKind !== "room_event" &&
    (!followupRun.run.inputProvenance ||
      followupRun.run.inputProvenance.kind === "external_user") &&
    (!requesterPrincipalKey || requesterPrincipalKey !== operation?.requesterPrincipalKey)
  );
}
