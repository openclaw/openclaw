import type { OpenClawConfig } from "../../config/config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  normalizeReasoningLevel,
  normalizeVerboseLevel,
  type ReasoningLevel,
  type VerboseLevel,
} from "../thinking.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type SurfaceDefaultsMap = NonNullable<NonNullable<AgentDefaults>["surfaceDefaults"]>;
type SurfaceDefaultsEntry = NonNullable<SurfaceDefaultsMap[string]>;

export function normalizeSurfaceDefaultKey(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalizeMessageChannel(normalized) ?? normalized;
}

function resolveSurfaceDefaultsEntry(
  map: SurfaceDefaultsMap | undefined,
  surfaceKey: string,
): SurfaceDefaultsEntry | undefined {
  if (!map) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(map, surfaceKey)) {
    return map[surfaceKey];
  }
  for (const [rawKey, entry] of Object.entries(map)) {
    if (normalizeSurfaceDefaultKey(rawKey) === surfaceKey) {
      return entry;
    }
  }
  return undefined;
}

export function resolveSurfaceDirectiveDefaults(params: {
  agentCfg?: AgentDefaults;
  surface?: string | null;
  provider?: string | null;
}): {
  surfaceKey?: string;
  verboseDefault?: VerboseLevel;
  reasoningDefault?: ReasoningLevel;
} {
  const map = params.agentCfg?.surfaceDefaults;
  const candidates = [
    normalizeSurfaceDefaultKey(params.surface),
    normalizeSurfaceDefaultKey(params.provider),
  ].filter((value): value is string => Boolean(value));

  if (candidates.length === 0 || !map) {
    return { surfaceKey: candidates[0] };
  }

  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);
    const entry = resolveSurfaceDefaultsEntry(map, candidate);
    if (!entry) {
      continue;
    }
    return {
      surfaceKey: candidate,
      verboseDefault: normalizeVerboseLevel(entry.verboseDefault),
      reasoningDefault: normalizeReasoningLevel(entry.reasoningDefault),
    };
  }

  return { surfaceKey: candidates[0] };
}
