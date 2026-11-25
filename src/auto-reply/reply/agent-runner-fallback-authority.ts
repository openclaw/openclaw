import { resolveManifestModelCatalogProviderAliasMetadata } from "../../agents/embedded-agent-runner/model.manifest-alias.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ReplyOperation,
  ReplyToolAuthorityRoute,
} from "../../sessions/session-controller.contracts.js";

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
