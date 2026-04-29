import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AgentCommandLaneConfig } from "./types.agents-shared.js";
import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_COMMAND_LANE = "main";

export type ResolvedAgentCommandLaneConfig = {
  lane: string;
  maxConcurrent?: number;
};

function normalizeCommandLaneName(value: string | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function normalizeCommandLaneMaxConcurrent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeCommandLaneConfig(config: AgentCommandLaneConfig | undefined): {
  id?: string;
  maxConcurrent?: number;
} {
  return {
    id: normalizeCommandLaneName(config?.id),
    maxConcurrent: normalizeCommandLaneMaxConcurrent(config?.maxConcurrent),
  };
}

function resolveAgentEntry(
  cfg: OpenClawConfig,
  agentId: string | undefined | null,
): NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number] | undefined {
  const normalizedAgentId = normalizeCommandLaneName(agentId ?? undefined);
  if (!normalizedAgentId || !Array.isArray(cfg.agents?.list)) {
    return undefined;
  }
  const id = normalizeAgentId(normalizedAgentId);
  return cfg.agents.list.find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveAgentCommandLaneConfig(
  cfg: OpenClawConfig,
  agentId: string | undefined | null,
): ResolvedAgentCommandLaneConfig {
  const defaults = normalizeCommandLaneConfig(cfg.agents?.defaults?.commandLane);
  const agent = resolveAgentEntry(cfg, agentId);
  const override = normalizeCommandLaneConfig(agent?.commandLane);
  const lane = override.id ?? defaults.id ?? DEFAULT_AGENT_COMMAND_LANE;
  const maxConcurrent = override.maxConcurrent ?? defaults.maxConcurrent;
  return {
    lane,
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
  };
}

export function resolveAgentCommandLane(
  cfg: OpenClawConfig,
  agentId: string | undefined | null,
): string {
  return resolveAgentCommandLaneConfig(cfg, agentId).lane;
}

export function listConfiguredAgentCommandLaneConcurrencies(
  cfg: OpenClawConfig,
): Array<{ lane: string; maxConcurrent: number }> {
  const lanes = new Map<string, number>();
  const add = (resolved: ResolvedAgentCommandLaneConfig) => {
    if (resolved.maxConcurrent !== undefined) {
      lanes.set(resolved.lane, resolved.maxConcurrent);
    }
  };

  add(resolveAgentCommandLaneConfig(cfg, undefined));

  for (const entry of cfg.agents?.list ?? []) {
    if (!entry.commandLane) {
      continue;
    }
    add(resolveAgentCommandLaneConfig(cfg, entry.id));
  }

  return Array.from(lanes, ([lane, maxConcurrent]) => ({ lane, maxConcurrent }));
}
