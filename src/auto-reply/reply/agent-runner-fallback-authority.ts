import { resolveManifestModelCatalogProviderAliasMetadata } from "../../agents/embedded-agent-runner/model.manifest-alias.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { resolveRequesterPrincipalKey } from "../../agents/requester-origin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ReplyOperation,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRoute,
} from "../../sessions/session-controller.contracts.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import { MessageInjectionTargetUnavailableError } from "./message-injection-authority.js";
import type { FollowupRun } from "./queue/types.js";
import { prepareFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

/** Keep selection changes separate from the concrete route and its effective tool authority. */
export async function resolveReplySteeringAuthority(
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

/** Only the fallback owner can establish that a new route still serves the original selection. */
export function bindReplyFallbackSteeringRoute(params: {
  operation: ReplyOperation | undefined;
  provenance: ModelFallbackAttemptProvenance;
  route: ReplyToolAuthorityRoute;
  config: OpenClawConfig;
  workspaceDir?: string;
}): void {
  const { operation, provenance, route } = params;
  if (!operation) {
    return;
  }
  const selected = operation.requestedToolAuthorityRoute;
  operation.setAutomaticFallbackRoute(undefined);
  if (
    provenance.stage !== "fallback" ||
    provenance.selectionChanged !== false ||
    selected?.provider !== provenance.requestedProvider ||
    selected?.model !== provenance.requestedModel
  ) {
    return;
  }
  const resolved = resolveManifestModelCatalogProviderAliasMetadata({
    provider: route.provider,
    modelId: route.model,
    cfg: params.config,
    workspaceDir: params.workspaceDir,
  });
  if (!resolved.ambiguous) {
    operation.setAutomaticFallbackRoute({ provider: resolved.provider, model: route.model });
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
