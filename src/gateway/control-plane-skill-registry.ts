import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { loadControlPlaneRuntimeState } from "./control-plane-runtime.js";

type JsonObject = Record<string, unknown>;

export type ControlPlaneSkillSearchItem = {
  skillKey?: string;
  name?: string;
  summary?: string | null;
  recommendationReason?: string | null;
  currentPublishedVersion?: {
    version?: string;
    description?: string | null;
  } | null;
};

export type ControlPlaneSkillSearchResult = {
  query: string;
  count: number;
  items: ControlPlaneSkillSearchItem[];
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const errorValue = payload.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }
  if (isJsonObject(errorValue)) {
    const code = typeof errorValue.code === "string" ? errorValue.code.trim() : "";
    const message = typeof errorValue.message === "string" ? errorValue.message.trim() : "";
    if (code && message) {
      return `${code}: ${message}`;
    }
    if (message) {
      return message;
    }
  }
  const messageValue = payload.message;
  return typeof messageValue === "string" && messageValue.trim() ? messageValue.trim() : undefined;
}

export function readControlPlaneBaseUrl(): string {
  const candidates = [
    process.env.AGENT_BOT_API_BASE_URL,
    process.env.CONTROL_PLANE_BASE_URL,
    process.env.AGENT_BOT_BASE_URL,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      return value.endsWith("/") ? value : `${value}/`;
    }
  }
  throw new Error(
    "Missing AGENT_BOT_API_BASE_URL (or CONTROL_PLANE_BASE_URL) for skill registry access.",
  );
}

export function buildRuntimeHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const bridgeToken = process.env.OPENCLAW_BRIDGE_TOKEN?.trim();
  if (bridgeToken) {
    headers["x-openclaw-bridge-token"] = bridgeToken;
  }
  return headers;
}

export async function requestControlPlaneJson(
  pathname: string,
  body: JsonObject,
): Promise<JsonObject> {
  const baseUrl = readControlPlaneBaseUrl();
  const requestUrl = new URL(pathname, baseUrl).toString();
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    timeoutMs: 45_000,
    auditContext: "control-plane-skill-registry",
    init: {
      method: "POST",
      headers: buildRuntimeHeaders(),
      body: JSON.stringify(body),
    },
  });

  try {
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      throw new Error(
        readErrorMessage(payload) ??
          `control plane request failed (${response.status} ${response.statusText})`,
      );
    }
    if (!isJsonObject(payload)) {
      throw new Error("control plane returned a non-object payload");
    }
    if (payload.success === false) {
      throw new Error(readErrorMessage(payload) ?? "control plane reported failure");
    }
    const data = isJsonObject(payload.data) ? payload.data : undefined;
    return data ?? payload;
  } finally {
    await release();
  }
}

export function buildRuntimeAgentContext(): JsonObject {
  const runtimeState = loadControlPlaneRuntimeState();
  return {
    runtimeRole: runtimeState.runtimeRole ?? null,
    remoteAgentId: runtimeState.remoteAgentId ?? null,
    machineName: runtimeState.machineName ?? null,
    instanceId: runtimeState.instanceId ?? null,
    instanceKey: runtimeState.instanceKey ?? null,
    skillSnapshotId: runtimeState.skillSnapshotId ?? null,
  };
}

export async function recommendSkillsFromControlPlane(params: {
  query: string;
  limit?: number;
  agentContext?: JsonObject;
}): Promise<ControlPlaneSkillSearchResult> {
  const data = await requestControlPlaneJson("/api/skill-registry/runtime/recommend", {
    query: params.query,
    limit: Math.max(1, Math.min(10, params.limit ?? 5)),
    agentContext: params.agentContext ?? buildRuntimeAgentContext(),
  });

  return {
    query: typeof data.query === "string" ? data.query : params.query,
    count: typeof data.count === "number" ? data.count : 0,
    items: Array.isArray(data.items) ? (data.items as ControlPlaneSkillSearchItem[]) : [],
  };
}
