import type { OpenClawConfig } from "../config/config.js";

export type ConsortiumRecord = {
  id: string;
  memberAgentIds: string[];
  label?: string;
};

export function mergeConsortiumDefinitions(cfg: OpenClawConfig): ConsortiumRecord[] {
  const raw = cfg.skills?.hive?.consortiums;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is ConsortiumRecord => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      id: String(entry.id ?? "").trim(),
      memberAgentIds: Array.isArray(entry.memberAgentIds)
        ? entry.memberAgentIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [],
      label: typeof entry.label === "string" ? entry.label : undefined,
    }))
    .filter((entry) => entry.id.length > 0);
}

/** All agent IDs that share a consortium with `agentId` (including `agentId`). */
export function resolveConsortiumPeerAgentIds(
  agentId: string,
  consortiums: ConsortiumRecord[],
): Set<string> {
  const peers = new Set<string>();
  peers.add(agentId);
  for (const consortium of consortiums) {
    const members = consortium.memberAgentIds ?? [];
    if (members.includes(agentId)) {
      for (const m of members) {
        peers.add(m);
      }
    }
  }
  return peers;
}
