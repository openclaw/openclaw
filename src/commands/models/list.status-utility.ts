import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { readUtilityModelSetting } from "../../agents/utility-model-setting.js";
import { resolveUtilityModelRefForAgent } from "../../agents/utility-model.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

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
  const ref = resolveUtilityModelRefForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    ...(params.gatewayCatalog ? { catalog: { entries: params.gatewayCatalog.models } } : {}),
  });
  const fallbacks = setting.kind === "disabled" ? [] : setting.fallbacks;
  const source =
    setting.kind === "explicit" || fallbacks.some((fallback) => fallback.trim() === ref)
      ? "config"
      : setting.kind === "disabled"
        ? "disabled"
        : ref
          ? "provider-default"
          : "none";
  return { ref, fallbacks, source } as const;
}
