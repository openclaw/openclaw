import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { selectUtilityModel } from "../../agents/utility-model-selection.js";
import { readUtilityModelSetting } from "../../agents/utility-model-setting.js";
import { resolveUtilityModelSelectionForAgent } from "../../agents/utility-model.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";

/**
 * Narration/titles ride the utility model on a plain API auth path that can differ
 * from the primary's (e.g. OAuth primary, api_key utility); status shows the resolved
 * ref so a broken utility credential is inspectable. A routed automatic model needs
 * the router's inventory, which the Gateway's published catalog supplies.
 */
export function resolveStatusUtilityModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  gatewayCatalog?: ModelsListResult;
}) {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  // Public rows omit account inventories; the Gateway publishes the scoped decision.
  const selection =
    params.gatewayCatalog?.utilityModel ??
    resolveUtilityModelSelectionForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      ...(params.gatewayCatalog ? { catalog: { entries: params.gatewayCatalog.models } } : {}),
    });
  const fallbacks = setting.kind === "disabled" ? [] : setting.fallbacks;
  const ref = "modelRef" in selection ? (selection.modelRef ?? undefined) : undefined;
  const source =
    "source" in selection ? selection.source : setting.kind === "disabled" ? "disabled" : "none";
  return {
    ref,
    fallbacks,
    source,
    notOffered: isUtilityModelNotOffered({ ...params, utilityModel: { modelRef: ref, source } }),
  } as const;
}

/** The status "Utility model" field: the display ref and how it was chosen. */
export function formatStatusUtilityModel(
  displayRef: string | null,
  utility: ReturnType<typeof resolveStatusUtilityModel>,
): string {
  if (!displayRef) {
    return utility.source === "disabled" ? "off" : "-";
  }
  if (utility.notOffered) {
    return `${displayRef} (${UTILITY_MODEL_NOT_OFFERED_NOTE})`;
  }
  return utility.source === "provider-default" ? `${displayRef} (provider default)` : displayRef;
}

/** Shown when automatic routing found no offered utility model and tasks use the main model. */
export const UTILITY_MODEL_NOT_OFFERED_NOTE = "utility model not offered; using main model";

/**
 * Automatic routing substitutes the agent's primary when the catalog offers no
 * utility candidate but lists the primary, and publishes it as the provider
 * default. Offline, with inventory unknown, the same config keeps its declared
 * choice; a published ref that is the primary and differs from that choice is
 * the substitution, so a provider whose small model is the primary never matches.
 */
export function isUtilityModelNotOffered(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** The Gateway's published agent-scoped decision (`ModelsListResult.utilityModel`). */
  utilityModel: { modelRef?: string | null; source: string } | undefined;
}): boolean {
  const published = params.utilityModel?.modelRef;
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  if (
    !published ||
    !primary ||
    params.utilityModel?.source !== "provider-default" ||
    readUtilityModelSetting(params.cfg, params.agentId).kind !== "auto"
  ) {
    return false;
  }
  const model = (ref: string) => splitTrailingAuthProfile(ref).model.toLowerCase();
  // Load the manifests explicitly: a command like Doctor has no current snapshot,
  // and without the provider's declaration every primary would look substituted.
  const declared = selectUtilityModel({
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: { entries: [], authoritative: false },
    metadataSnapshot: loadManifestMetadataSnapshot({ config: params.cfg }),
  });
  return (
    model(published) === `${primary.provider}/${primary.model}`.toLowerCase() &&
    !("modelRef" in declared && model(declared.modelRef) === model(published))
  );
}
