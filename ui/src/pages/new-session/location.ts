export type NewSessionRouteData = {
  agentId: string;
  model: string;
  catalogLabel: string;
};

export type NewSessionTarget = { model: string; label: string };

export function newSessionRouteKey(data: NewSessionRouteData | undefined): string {
  return JSON.stringify([data?.agentId ?? "", data?.model ?? "", data?.catalogLabel ?? ""]);
}

export function newSessionSearch(agentId: string, target?: NewSessionTarget): string {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent", agentId);
  }
  if (target) {
    params.set("model", target.model);
    params.set("catalog", target.label);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionDataFromSearch(search: string): NewSessionRouteData {
  const params = new URLSearchParams(search);
  return {
    agentId: params.get("agent")?.trim() ?? "",
    model: params.get("model")?.trim() ?? "",
    catalogLabel: params.get("catalog")?.trim() ?? "",
  };
}
