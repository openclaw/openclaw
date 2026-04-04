import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSnapshot } from "../types.ts";

export type DreamingMode = "off" | "core" | "rem" | "deep";

export type DreamingStatus = {
  mode: DreamingMode;
  enabled: boolean;
  frequency: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  shortTermCount: number;
  promotedTotal: number;
  promotedToday: number;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
  storePath?: string;
  storeError?: string;
};

type DoctorMemoryStatusPayload = {
  dreaming?: unknown;
};

export type DreamingState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configSnapshot: ConfigSnapshot | null;
  applySessionKey: string;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamingModeSaving: boolean;
  lastError: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDreamingMode(value: unknown): DreamingMode {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "rem" ||
    normalized === "deep"
  ) {
    return normalized;
  }
  return "off";
}

function normalizeFiniteInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeFiniteScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeDreamingStatus(raw: unknown): DreamingStatus | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const mode = normalizeDreamingMode(record.mode);
  const enabled = typeof record.enabled === "boolean" ? record.enabled : mode !== "off";
  const frequency = normalizeTrimmedString(record.frequency) ?? "";
  const timezone = normalizeTrimmedString(record.timezone);
  const nextRunRaw = record.nextRunAtMs;
  const nextRunAtMs =
    typeof nextRunRaw === "number" && Number.isFinite(nextRunRaw) ? nextRunRaw : undefined;

  return {
    mode,
    enabled,
    frequency,
    ...(timezone ? { timezone } : {}),
    limit: normalizeFiniteInt(record.limit, 0),
    minScore: normalizeFiniteScore(record.minScore, 0),
    minRecallCount: normalizeFiniteInt(record.minRecallCount, 0),
    minUniqueQueries: normalizeFiniteInt(record.minUniqueQueries, 0),
    shortTermCount: normalizeFiniteInt(record.shortTermCount, 0),
    promotedTotal: normalizeFiniteInt(record.promotedTotal, 0),
    promotedToday: normalizeFiniteInt(record.promotedToday, 0),
    managedCronPresent: record.managedCronPresent === true,
    ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
    ...(normalizeTrimmedString(record.storePath)
      ? { storePath: normalizeTrimmedString(record.storePath) }
      : {}),
    ...(normalizeTrimmedString(record.storeError)
      ? { storeError: normalizeTrimmedString(record.storeError) }
      : {}),
  };
}

export async function loadDreamingStatus(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.dreamingStatusLoading) {
    return;
  }
  state.dreamingStatusLoading = true;
  state.dreamingStatusError = null;
  try {
    const payload = await state.client.request<DoctorMemoryStatusPayload>(
      "doctor.memory.status",
      {},
    );
    state.dreamingStatus = normalizeDreamingStatus(payload?.dreaming);
  } catch (err) {
    state.dreamingStatusError = String(err);
  } finally {
    state.dreamingStatusLoading = false;
  }
}

export async function updateDreamingMode(
  state: DreamingState,
  mode: DreamingMode,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.dreamingModeSaving) {
    return false;
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.dreamingStatusError = "Config hash missing; refresh and retry.";
    return false;
  }

  state.dreamingModeSaving = true;
  state.dreamingStatusError = null;
  try {
    await state.client.request("config.patch", {
      baseHash,
      raw: JSON.stringify({
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  mode,
                },
              },
            },
          },
        },
      }),
      sessionKey: state.applySessionKey,
      note: "Dreaming mode updated from Dreams tab.",
    });
    if (state.dreamingStatus) {
      state.dreamingStatus = {
        ...state.dreamingStatus,
        mode,
        enabled: mode !== "off",
      };
    }
    return true;
  } catch (err) {
    const message = String(err);
    state.dreamingStatusError = message;
    state.lastError = message;
    return false;
  } finally {
    state.dreamingModeSaving = false;
  }
}
