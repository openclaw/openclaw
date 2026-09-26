import { resolveManifestModelCatalogProviderAliasMetadata } from "../../agents/embedded-agent-runner/model.manifest-alias.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperation, ReplyToolAuthorityRoute } from "./reply-run-registry.contracts.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

/** Keep selection changes separate from the concrete route and its effective tool authority. */
export function resolveReplySteeringAuthority(
  followupRun: FollowupRun,
  operation: ReplyOperation | undefined,
) {
  const incomingFingerprint = resolveFollowupRunToolAuthorityFingerprint(followupRun);
  const activeFingerprint = operation?.toolAuthorityFingerprint;
  const activeRoute = operation?.toolAuthorityRoute;
  const incomingAtActiveRoute = activeRoute
    ? resolveFollowupRunToolAuthorityFingerprint(followupRun, activeRoute)
    : undefined;
  const authorityMismatch = operation !== undefined && activeFingerprint !== incomingFingerprint;
  const routeOnlyMismatch =
    authorityMismatch &&
    activeFingerprint !== undefined &&
    incomingAtActiveRoute === activeFingerprint;
  const selectedRoute = operation?.requestedToolAuthorityRoute;
  const selectionChanged =
    selectedRoute !== undefined &&
    (selectedRoute.provider !== followupRun.run.provider ||
      selectedRoute.model !== followupRun.run.model);
  const fallbackRoute = operation?.automaticFallbackRoute;
  const fallbackSelection = routeOnlyMismatch
    ? resolveModelFallbackOptions(followupRun.run).modelFallbackAvailability
    : undefined;
  const automaticFallbackRoute =
    routeOnlyMismatch &&
    selectedRoute !== undefined &&
    !selectionChanged &&
    fallbackSelection?.kind !== "disabled_by_model_override" &&
    fallbackSelection?.kind !== "disabled_by_model_selection_lock" &&
    fallbackRoute?.provider === activeRoute?.provider &&
    fallbackRoute?.model === activeRoute?.model
      ? fallbackRoute
      : undefined;
  return {
    toolAuthorityFingerprint: automaticFallbackRoute
      ? (incomingAtActiveRoute ?? incomingFingerprint)
      : incomingFingerprint,
    automaticFallbackRoute,
    pendingInputAuthorityFingerprint: routeOnlyMismatch ? activeFingerprint : undefined,
    shouldQueueAuthorityMismatch: selectionChanged || (authorityMismatch && !routeOnlyMismatch),
  };
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
