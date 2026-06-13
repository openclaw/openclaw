export const CONTROL_DIRECTOR_AGENT_IDS = ["main", "control-director"] as const;
export const CONTROL_DIRECTOR_PRIMARY_PROVIDER = "ollama";
export const CONTROL_DIRECTOR_PRIMARY_PROVIDER_LABEL = "Ollama";
export const CONTROL_DIRECTOR_PRIMARY_ALIAS = "openclaw-control-qwen36-27b";
export const CONTROL_DIRECTOR_PRIMARY_MODEL_ID = "openclaw-control-qwen36-27b:latest";
export const CONTROL_DIRECTOR_PRIMARY_MODEL_VALUE = `${CONTROL_DIRECTOR_PRIMARY_PROVIDER}/${CONTROL_DIRECTOR_PRIMARY_MODEL_ID}`;
export const CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG = "qwen3.6:27b-q8_0";
export const CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL = "OpenClaw Control Qwen3.6 27B Q8_0";
export const CONTROL_DIRECTOR_FIRST_FALLBACK_MODEL = "ollama/openclaw-control-qwen25-32b:latest";

function normalizeModelCandidate(value: string | undefined | null): string {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) {
    return "";
  }
  const modelPart = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const stablePart = modelPart.split("@")[0]?.split(/\s+/)[0] ?? "";
  return stablePart.replace(/:latest$/i, "");
}

export function isControlDirectorAgentId(agentId: string | undefined | null): boolean {
  const normalized = agentId?.trim().toLowerCase();
  return Boolean(
    normalized && CONTROL_DIRECTOR_AGENT_IDS.some((candidate) => candidate === normalized),
  );
}

export function isControlDirectorPrimaryModelRef(value: string | undefined | null): boolean {
  const normalized = normalizeModelCandidate(value);
  return (
    normalized === CONTROL_DIRECTOR_PRIMARY_ALIAS ||
    normalized === CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG
  );
}

export function isControlDirectorAllowedModelRef(value: string | undefined | null): boolean {
  const normalized = normalizeModelCandidate(value);
  return (
    normalized === CONTROL_DIRECTOR_PRIMARY_ALIAS ||
    normalized === CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG ||
    normalized === "openclaw-control-qwen25-32b" ||
    normalized === "qwen25-32b"
  );
}

export function resolveControlDirectorPrimaryModelValue(params: {
  agentId?: string | undefined | null;
  provider?: string | undefined | null;
  model?: string | undefined | null;
}): string | null {
  if (
    !isControlDirectorAgentId(params.agentId) ||
    !isControlDirectorPrimaryModelRef(params.model)
  ) {
    return null;
  }
  return CONTROL_DIRECTOR_PRIMARY_MODEL_VALUE;
}

export function formatControlDirectorPrimaryModelDisplay(value: string): string | null {
  if (!isControlDirectorPrimaryModelRef(value)) {
    return null;
  }
  return `${CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL} · ${CONTROL_DIRECTOR_PRIMARY_PROVIDER_LABEL}`;
}

export function formatControlDirectorDetailModelDisplay(value: string): string {
  if (!isControlDirectorPrimaryModelRef(value)) {
    return value;
  }
  return `${CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL} (${CONTROL_DIRECTOR_PRIMARY_MODEL_VALUE})`;
}
