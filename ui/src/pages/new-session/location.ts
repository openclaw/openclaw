import {
  buildModelCatalogRef,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";

export type NewSessionRouteData = {
  /** The agent the loader resolved; empty until the Gateway can name one. */
  agentId: string;
  /** The agent the URL asked for, which only a navigation can change. */
  requestedAgentId: string;
  catalogId: string;
  /** An explicit model for this unsent draft, separate from saved preferences. */
  requestedModel?: string;
  group?: string;
  groupStatus?: "resolved" | "missing" | "unavailable";
  groupCwd?: string;
  groupWorktree?: boolean;
  groupCatalogGeneration?: number;
  groupDefaultsStatus?: import("../../lib/sessions/session-capability.ts").SessionGroupDefaultsStatus;
  model: string;
  catalogLabel: string;
  startTerminal: boolean;
  terminalHosts?: Array<{ hostId: string; label: string }>;
};

export type NewSessionTarget =
  | { catalogId: string; group?: never; model?: never }
  | { group: string; catalogId?: never; model?: never }
  | { model: string; catalogId?: never; group?: never };

function requestedModel(value: string | null): string | undefined {
  if (
    !value ||
    value.length > 2048 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return undefined;
  }
  const parsed = parseModelCatalogRef(value);
  return parsed ? buildModelCatalogRef(parsed.provider, parsed.modelId) : undefined;
}

export function newSessionSearch(agentId: string, target?: NewSessionTarget): string {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent", agentId);
  }
  if (target?.catalogId) {
    params.set("catalog", target.catalogId);
  }
  if (target?.group) {
    params.set("group", target.group);
  }
  const model = requestedModel(target?.model ?? null);
  if (model) {
    params.set("model", model);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionLocationFromSearch(
  search: string,
): Pick<NewSessionRouteData, "agentId" | "catalogId" | "group" | "requestedModel"> {
  const params = new URLSearchParams(search);
  const catalogId = params.get("catalog")?.trim() ?? "";
  const model = catalogId ? undefined : requestedModel(params.get("model"));
  return {
    ...(model ? { requestedModel: model } : {}),
    agentId: params.get("agent")?.trim() ?? "",
    catalogId,
    group: params.get("group")?.trim() ?? "",
  };
}
