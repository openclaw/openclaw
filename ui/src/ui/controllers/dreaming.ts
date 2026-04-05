import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSnapshot } from "../types.ts";

export type DreamingMode = "off" | "core" | "rem" | "deep";

type DreamingPhaseStatusBase = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type LightDreamingStatus = DreamingPhaseStatusBase & {
  lookbackDays: number;
  limit: number;
};

type DeepDreamingStatus = DreamingPhaseStatusBase & {
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
};

type RemDreamingStatus = DreamingPhaseStatusBase & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

export type DreamingStatus = {
  mode: DreamingMode;
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  storeError?: string;
  phases: {
    light: LightDreamingStatus;
    deep: DeepDreamingStatus;
    rem: RemDreamingStatus;
  };
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

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
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

function normalizeStorageMode(value: unknown): DreamingStatus["storageMode"] {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (normalized === "inline" || normalized === "separate" || normalized === "both") {
    return normalized;
  }
  return "inline";
}

function normalizeDreamingMode(value: unknown): DreamingMode | undefined {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "rem" ||
    normalized === "deep"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeNextRun(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePhaseStatusBase(record: Record<string, unknown> | null): DreamingPhaseStatusBase {
  return {
    enabled: normalizeBoolean(record?.enabled, false),
    cron: normalizeTrimmedString(record?.cron) ?? "",
    managedCronPresent: normalizeBoolean(record?.managedCronPresent, false),
    ...(normalizeNextRun(record?.nextRunAtMs) !== undefined
      ? { nextRunAtMs: normalizeNextRun(record?.nextRunAtMs) }
      : {}),
  };
}

function normalizeDreamingStatus(raw: unknown): DreamingStatus | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const phasesRecord = asRecord(record.phases);
  const lightRecord = asRecord(phasesRecord?.light);
  const deepRecord = asRecord(phasesRecord?.deep);
  const remRecord = asRecord(phasesRecord?.rem);
  const timezone = normalizeTrimmedString(record.timezone);
  const storePath = normalizeTrimmedString(record.storePath);
  const storeError = normalizeTrimmedString(record.storeError);
  const explicitMode = normalizeDreamingMode(record.mode);
  const enabled = normalizeBoolean(record.enabled, false);
  const mode = explicitMode ?? (enabled ? "core" : "off");

  return {
    mode,
    enabled,
    ...(timezone ? { timezone } : {}),
    verboseLogging: normalizeBoolean(record.verboseLogging, false),
    storageMode: normalizeStorageMode(record.storageMode),
    separateReports: normalizeBoolean(record.separateReports, false),
    shortTermCount: normalizeFiniteInt(record.shortTermCount, 0),
    promotedTotal: normalizeFiniteInt(record.promotedTotal, 0),
    promotedToday: normalizeFiniteInt(record.promotedToday, 0),
    ...(storePath ? { storePath } : {}),
    ...(storeError ? { storeError } : {}),
    phases: {
      light: {
        ...normalizePhaseStatusBase(lightRecord),
        lookbackDays: normalizeFiniteInt(lightRecord?.lookbackDays, 0),
        limit: normalizeFiniteInt(lightRecord?.limit, 0),
      },
      deep: {
        ...normalizePhaseStatusBase(deepRecord),
        limit: normalizeFiniteInt(deepRecord?.limit, 0),
        minScore: normalizeFiniteScore(deepRecord?.minScore, 0),
        minRecallCount: normalizeFiniteInt(deepRecord?.minRecallCount, 0),
        minUniqueQueries: normalizeFiniteInt(deepRecord?.minUniqueQueries, 0),
        recencyHalfLifeDays: normalizeFiniteInt(deepRecord?.recencyHalfLifeDays, 0),
        ...(typeof deepRecord?.maxAgeDays === "number" && Number.isFinite(deepRecord.maxAgeDays)
          ? { maxAgeDays: normalizeFiniteInt(deepRecord.maxAgeDays, 0) }
          : {}),
      },
      rem: {
        ...normalizePhaseStatusBase(remRecord),
        lookbackDays: normalizeFiniteInt(remRecord?.lookbackDays, 0),
        limit: normalizeFiniteInt(remRecord?.limit, 0),
        minPatternStrength: normalizeFiniteScore(remRecord?.minPatternStrength, 0),
      },
    },
  };
}

export async function loadDreamingStatus(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.dreamingStatusLoading) {
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

async function writeDreamingPatch(
  state: DreamingState,
  patch: Record<string, unknown>,
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
      raw: JSON.stringify(patch),
      sessionKey: state.applySessionKey,
      note: "Dreaming settings updated from the Dreaming tab.",
    });
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

export async function updateDreamingEnabled(
  state: DreamingState,
  enabled: boolean,
): Promise<boolean> {
  return updateDreamingMode(state, enabled ? "core" : "off");
}

export async function updateDreamingMode(
  state: DreamingState,
  mode: DreamingMode,
): Promise<boolean> {
  const ok = await writeDreamingPatch(state, {
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
  });
  if (ok && state.dreamingStatus) {
    state.dreamingStatus = {
      ...state.dreamingStatus,
      mode,
      enabled: mode !== "off",
    };
  }
  return ok;
}
