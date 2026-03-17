import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
} from "../routing/session-key.js";

const TUI_ORIGIN_PREFIX = "session:tui:";

function normalizeAffinitySegment(value: string | undefined | null): string | undefined {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 96);
  return normalized || undefined;
}

export function normalizeGatewayClientAffinityId(
  value: string | undefined | null,
): string | undefined {
  return normalizeAffinitySegment(value);
}

export function buildGatewayTuiOriginTarget(
  instanceId: string | undefined | null,
): string | undefined {
  const normalized = normalizeGatewayClientAffinityId(instanceId);
  return normalized ? `${TUI_ORIGIN_PREFIX}${normalized}` : undefined;
}

export function parseGatewayTuiOriginTarget(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed.startsWith(TUI_ORIGIN_PREFIX)) {
    return undefined;
  }
  return normalizeGatewayClientAffinityId(trimmed.slice(TUI_ORIGIN_PREFIX.length));
}

export function buildTuiAffinitySessionKey(params: {
  agentId: string;
  mainKey?: string | null;
  instanceId: string;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  const instanceId = normalizeGatewayClientAffinityId(params.instanceId) ?? "default";
  return `agent:${agentId}:tui:${mainKey}:${instanceId}`;
}

export function isTuiMainSessionAlias(params: {
  raw?: string | null;
  currentAgentId: string;
  sessionMainKey: string;
}): boolean {
  const trimmed = (params.raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "main") {
    return true;
  }
  const mainKey = normalizeMainKey(params.sessionMainKey);
  if (trimmed === mainKey) {
    return true;
  }
  return (
    trimmed ===
    buildAgentMainSessionKey({
      agentId: params.currentAgentId,
      mainKey,
    }).toLowerCase()
  );
}
