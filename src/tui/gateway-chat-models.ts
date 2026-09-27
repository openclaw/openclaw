import type { GatewayClient } from "../gateway/client.js";
import type { TuiModelChoice } from "./tui-backend.js";

export type GatewayModelCatalogEntry = {
  models?: TuiModelChoice[];
  pending?: Promise<TuiModelChoice[]>;
};

/** Short picker hint for a model the Gateway reports as unavailable. */
export function describeTuiModelUnavailableReason(
  reason: TuiModelChoice["unavailableReason"],
): string {
  return reason === "not-provisioned"
    ? "not available for this account"
    : (reason ?? "unavailable");
}

/** Recovery hint for a model the Gateway reports as unavailable in the TUI picker. */
export function resolveTuiModelUnavailableGuidance(
  reason: TuiModelChoice["unavailableReason"],
): string {
  if (reason === "cooldown") {
    return "Wait and retry, or choose another model.";
  }
  if (reason === "not-provisioned") {
    return "This account cannot use it. Choose another model.";
  }
  return "Run openclaw models auth login or choose another model.";
}

export function refreshTuiGatewayModelCatalog(params: {
  catalogs: Map<string | undefined, GatewayModelCatalogEntry>;
  client: Pick<GatewayClient, "request">;
  agentId?: string;
  published: boolean;
  onChanged?: (agentId?: string) => void;
}): Promise<TuiModelChoice[]> {
  const { catalogs, client, agentId, published, onChanged } = params;
  let entry = catalogs.get(agentId);
  if (!entry) {
    entry = {};
    catalogs.set(agentId, entry);
  }
  if (entry.pending) {
    return entry.pending;
  }
  const owner = entry;
  const current = () => catalogs.get(agentId) === owner && owner.pending === pending;
  const pending = client
    .request("models.list", {
      ...(agentId ? { agentId } : {}),
      ...(published ? { includeDetails: true } : {}),
    })
    .then((res) => {
      if (!current()) {
        return catalogs.get(agentId)?.models ?? [];
      }
      const models: TuiModelChoice[] = Array.isArray(res?.models) ? res.models : [];
      // Released Gateways reject includeDetails and collapse unknown availability to false.
      owner.models = published
        ? models
        : models.map(({ available: _available, unavailableReason: _reason, ...model }) => model);
      onChanged?.(agentId);
      return owner.models;
    })
    .catch((error: unknown) => {
      if (!current()) {
        return catalogs.get(agentId)?.models ?? [];
      }
      throw error;
    })
    .finally(() => {
      if (current()) {
        owner.pending = undefined;
      }
    });
  owner.pending = pending;
  return pending;
}
