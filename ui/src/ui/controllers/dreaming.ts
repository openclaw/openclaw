import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeOptionalLowercaseString } from "../string-coerce.ts";
import type { ConfigSnapshot } from "../types.ts";

export type DreamingPhaseId = "light" | "deep" | "rem";
const DEFAULT_DREAM_DIARY_PATH = "DREAMS.md";
const DEFAULT_DREAMING_PLUGIN_ID = "memory-core";

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
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
  phaseSignalError?: string;
  phases: {
    light: LightDreamingStatus;
    deep: DeepDreamingStatus;
    rem: RemDreamingStatus;
  };
};

type DoctorMemoryStatusPayload = {
  dreaming?: unknown;
};

type DoctorMemoryDreamDiaryPayload = {
  found?: unknown;
  path?: unknown;
  content?: unknown;
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
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
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
  const normalized = normalizeOptionalLowercaseString(normalizeTrimmedString(value));
  if (normalized === "inline" || normalized === "separate" || normalized === "both") {
    return normalized;
  }
  return "inline";
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

function resolveDreamingPluginId(configValue: Record<string, unknown> | null): string {
  const plugins = asRecord(configValue?.plugins);
  const slots = asRecord(plugins?.slots);
  const configuredSlot = normalizeTrimmedString(slots?.memory);
  if (configuredSlot && normalizeOptionalLowercaseString(configuredSlot) !== "none") {
    return configuredSlot;
  }
  return DEFAULT_DREAMING_PLUGIN_ID;
}

export function resolveConfiguredDreaming(configValue: Record<string, unknown> | null): {
  pluginId: string;
  enabled: boolean;
} {
  const pluginId = resolveDreamingPluginId(configValue);
  const plugins = asRecord(configValue?.plugins);
  const entries = asRecord(plugins?.entries);
  const pluginEntry = asRecord(entries?.[pluginId]);
  const config = asRecord(pluginEntry?.config);
  const dreaming = asRecord(config?.dreaming);
  return {
    pluginId,
    enabled: normalizeBoolean(dreaming?.enabled, false),
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
  const phaseSignalPath = normalizeTrimmedString(record.phaseSignalPath);
  const storeError = normalizeTrimmedString(record.storeError);
  const phaseSignalError = normalizeTrimmedString(record.phaseSignalError);

  return {
    enabled: normalizeBoolean(record.enabled, false),
    ...(timezone ? { timezone } : {}),
    verboseLogging: normalizeBoolean(record.verboseLogging, false),
    storageMode: normalizeStorageMode(record.storageMode),
    separateReports: normalizeBoolean(record.separateReports, false),
    shortTermCount: normalizeFiniteInt(record.shortTermCount, 0),
    recallSignalCount: normalizeFiniteInt(record.recallSignalCount, 0),
    dailySignalCount: normalizeFiniteInt(record.dailySignalCount, 0),
    totalSignalCount: normalizeFiniteInt(record.totalSignalCount, 0),
    phaseSignalCount: normalizeFiniteInt(record.phaseSignalCount, 0),
    lightPhaseHitCount: normalizeFiniteInt(record.lightPhaseHitCount, 0),
    remPhaseHitCount: normalizeFiniteInt(record.remPhaseHitCount, 0),
    promotedTotal: normalizeFiniteInt(record.promotedTotal, 0),
    promotedToday: normalizeFiniteInt(record.promotedToday, 0),
    ...(storePath ? { storePath } : {}),
    ...(phaseSignalPath ? { phaseSignalPath } : {}),
    ...(storeError ? { storeError } : {}),
    ...(phaseSignalError ? { phaseSignalError } : {}),
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

export async function loadDreamDiary(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.dreamDiaryLoading) {
    return;
  }
  state.dreamDiaryLoading = true;
  state.dreamDiaryError = null;
  try {
    const payload = await state.client.request<DoctorMemoryDreamDiaryPayload>(
      "doctor.memory.dreamDiary",
      {},
    );
    const path = normalizeTrimmedString(payload?.path) ?? DEFAULT_DREAM_DIARY_PATH;
    const found = payload?.found === true;
    if (found) {
      state.dreamDiaryPath = path;
      state.dreamDiaryContent = typeof payload?.content === "string" ? payload.content : "";
    } else {
      state.dreamDiaryPath = path;
      state.dreamDiaryContent = null;
    }
  } catch (err) {
    state.dreamDiaryError = String(err);
  } finally {
    state.dreamDiaryLoading = false;
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

function lookupIncludesDreamingProperty(value: unknown): boolean {
  const lookup = asRecord(value);
  const children = Array.isArray(lookup?.children) ? lookup.children : [];
  for (const child of children) {
    const childRecord = asRecord(child);
    if (normalizeTrimmedString(childRecord?.key) === "dreaming") {
      return true;
    }
  }
  return false;
}

function lookupDisallowsUnknownProperties(value: unknown): boolean {
  const lookup = asRecord(value);
  const schema = asRecord(lookup?.schema);
  return schema?.additionalProperties === false;
}

async function ensureDreamingPathSupported(
  state: DreamingState,
  pluginId: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return true;
  }
  try {
    const lookup = await state.client.request("config.schema.lookup", {
      path: `plugins.entries.${pluginId}.config`,
    });
    if (lookupIncludesDreamingProperty(lookup)) {
      return true;
    }
    if (lookupDisallowsUnknownProperties(lookup)) {
      const message = `Selected memory plugin "${pluginId}" does not support dreaming settings.`;
      state.dreamingStatusError = message;
      state.lastError = message;
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

export async function updateDreamingEnabled(
  state: DreamingState,
  enabled: boolean,
): Promise<boolean> {
  if (state.dreamingModeSaving) {
    return false;
  }
  if (!state.configSnapshot?.hash) {
    state.dreamingStatusError = "Config hash missing; refresh and retry.";
    return false;
  }
  const { pluginId } = resolveConfiguredDreaming(asRecord(state.configSnapshot?.config) ?? null);
  if (!(await ensureDreamingPathSupported(state, pluginId))) {
    return false;
  }
  const ok = await writeDreamingPatch(state, {
    plugins: {
      entries: {
        [pluginId]: {
          config: {
            dreaming: {
              enabled,
            },
          },
        },
      },
    },
  });
  if (ok && state.dreamingStatus) {
    state.dreamingStatus = {
      ...state.dreamingStatus,
      enabled,
    };
  }
  return ok;
}
