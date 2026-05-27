import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import type { ConfigSnapshot } from "../types.ts";

export type MemoryAuditAction = "add" | "edit" | "delete" | "move";
export type MemoryAuditSurfaceKind =
  | "agent-memory"
  | "user-profile"
  | "tool-notes"
  | "shared-memory";
export type MemoryAuditSuggestionStatus = "pending" | "applied" | "rejected" | "conflict";

export type MemoryAuditSuggestionTarget = {
  surfaceId: string;
  kind: MemoryAuditSurfaceKind;
  path: string;
  workspaceDir: string;
  agentId?: string;
};

export type MemoryAuditSuggestion = {
  id: string;
  status: MemoryAuditSuggestionStatus;
  action: MemoryAuditAction;
  text: string;
  rationale: string;
  confidence: number;
  source?: MemoryAuditSuggestionTarget & {
    startLine: number;
    endLine: number;
    hash: string;
  };
  target: MemoryAuditSuggestionTarget;
  reviewerAgentId?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  conflict?: string;
};

export type MemoryAuditSuggestions = {
  agentId?: string;
  workspaces: string[];
  total: number;
  pending: number;
  applied: number;
  rejected: number;
  conflict: number;
  suggestions: MemoryAuditSuggestion[];
};

export type MemoryAuditDeliveryMode = "none" | "announce" | "webhook";
export type MemoryAuditTab = "settings" | "review";

export type MemoryAuditSettingsDraft = {
  enabled: boolean;
  agentId: string;
  sessionTarget: string;
  model: string;
  timezone: string;
  dailyEnabled: boolean;
  dailyCron: string;
  weeklyEnabled: boolean;
  weeklyCron: string;
  deliveryMode: MemoryAuditDeliveryMode;
  deliveryChannel: string;
  deliveryTo: string;
  deliveryThreadId: string;
  deliveryAccountId: string;
};

export type MemoryAuditSettingsErrors = Partial<
  Record<"sessionTarget" | "dailyCron" | "weeklyCron" | "deliveryTo", string>
>;

type MemoryAuditActionPayload = {
  action?: unknown;
  applied?: unknown;
  rejected?: unknown;
  conflict?: unknown;
};

type ConfigPatchResult = {
  noop?: unknown;
  restart?: unknown;
};

export type MemoryAuditState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  memoryAuditLoading: boolean;
  memoryAuditError: string | null;
  memoryAuditSuggestions: MemoryAuditSuggestions | null;
  memoryAuditActionId: string | null;
  memoryAuditActionMessage: { kind: "success" | "error"; text: string } | null;
  memoryAuditTab: MemoryAuditTab;
  memoryAuditSettingsLoading: boolean;
  memoryAuditSettingsSaving: boolean;
  memoryAuditSettingsError: string | null;
  memoryAuditSettingsMessage: { kind: "success" | "error"; text: string } | null;
  memoryAuditSettingsDraft: MemoryAuditSettingsDraft;
  memoryAuditSettingsOriginal: MemoryAuditSettingsDraft;
  memoryAuditSettingsPluginId: string;
  configSnapshot: ConfigSnapshot | null;
  applySessionKey: string;
  lastError: string | null;
};

export const DEFAULT_MEMORY_AUDIT_SETTINGS: MemoryAuditSettingsDraft = {
  enabled: false,
  agentId: "",
  sessionTarget: "session:memory-audit",
  model: "",
  timezone: "",
  dailyEnabled: true,
  dailyCron: "10 6 * * *",
  weeklyEnabled: true,
  weeklyCron: "0 21 * * 0",
  deliveryMode: "none",
  deliveryChannel: "",
  deliveryTo: "",
  deliveryThreadId: "",
  deliveryAccountId: "",
};

const DEFAULT_MEMORY_AUDIT_PLUGIN_ID = "memory-core";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeDeliveryMode(value: unknown): MemoryAuditDeliveryMode {
  return value === "announce" || value === "webhook" ? value : "none";
}

function readNestedRecord(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return asRecord(record?.[key]);
}

export function resolveMemoryAuditPluginId(config: unknown): string {
  const root = asRecord(config);
  const slot = normalizeTrimmedString(readNestedRecord(root, "plugins")?.slots);
  const slots = readNestedRecord(root, "plugins")?.slots;
  const memorySlot =
    slots && typeof slots === "object"
      ? normalizeTrimmedString((slots as Record<string, unknown>).memory)
      : undefined;
  if (memorySlot && memorySlot.toLowerCase() !== "none") {
    return memorySlot;
  }
  void slot;
  return DEFAULT_MEMORY_AUDIT_PLUGIN_ID;
}

function readMemoryAuditConfig(config: unknown, pluginId: string): Record<string, unknown> | null {
  const root = asRecord(config);
  const plugins = readNestedRecord(root, "plugins");
  const entries = readNestedRecord(plugins, "entries");
  const entry = readNestedRecord(entries, pluginId);
  const pluginConfig = readNestedRecord(entry, "config");
  return readNestedRecord(pluginConfig, "memoryAudit");
}

export function readMemoryAuditSettings(config: unknown): {
  pluginId: string;
  draft: MemoryAuditSettingsDraft;
} {
  const pluginId = resolveMemoryAuditPluginId(config);
  const audit = readMemoryAuditConfig(config, pluginId);
  const delivery = readNestedRecord(audit, "delivery");
  const daily = readNestedRecord(audit, "daily");
  const weekly = readNestedRecord(audit, "weekly");
  const draft: MemoryAuditSettingsDraft = {
    enabled: normalizeBoolean(audit?.enabled, DEFAULT_MEMORY_AUDIT_SETTINGS.enabled),
    agentId: normalizeTrimmedString(audit?.agentId) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.agentId,
    sessionTarget:
      normalizeTrimmedString(audit?.sessionTarget) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.sessionTarget,
    model: normalizeTrimmedString(audit?.model) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.model,
    timezone: normalizeTrimmedString(audit?.timezone) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.timezone,
    dailyEnabled: normalizeBoolean(daily?.enabled, DEFAULT_MEMORY_AUDIT_SETTINGS.dailyEnabled),
    dailyCron: normalizeTrimmedString(daily?.cron) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.dailyCron,
    weeklyEnabled: normalizeBoolean(weekly?.enabled, DEFAULT_MEMORY_AUDIT_SETTINGS.weeklyEnabled),
    weeklyCron: normalizeTrimmedString(weekly?.cron) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.weeklyCron,
    deliveryMode: normalizeDeliveryMode(delivery?.mode),
    deliveryChannel:
      normalizeTrimmedString(delivery?.channel) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.deliveryChannel,
    deliveryTo: normalizeTrimmedString(delivery?.to) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.deliveryTo,
    deliveryThreadId:
      normalizeTrimmedString(delivery?.threadId) ?? DEFAULT_MEMORY_AUDIT_SETTINGS.deliveryThreadId,
    deliveryAccountId:
      normalizeTrimmedString(delivery?.accountId) ??
      DEFAULT_MEMORY_AUDIT_SETTINGS.deliveryAccountId,
  };
  return { pluginId, draft };
}

export function buildMemoryAuditConfigPatch(
  pluginId: string,
  draft: MemoryAuditSettingsDraft,
): Record<string, unknown> {
  const deliveryActive = draft.deliveryMode !== "none";
  const delivery: Record<string, unknown> = {
    mode: draft.deliveryMode,
    channel: deliveryActive && draft.deliveryChannel.trim() ? draft.deliveryChannel.trim() : null,
    to: deliveryActive && draft.deliveryTo.trim() ? draft.deliveryTo.trim() : null,
    threadId:
      deliveryActive && draft.deliveryThreadId.trim() ? draft.deliveryThreadId.trim() : null,
    accountId:
      deliveryActive && draft.deliveryAccountId.trim() ? draft.deliveryAccountId.trim() : null,
  };
  return {
    plugins: {
      entries: {
        [pluginId]: {
          ...(draft.enabled ? { enabled: true } : {}),
          config: {
            memoryAudit: {
              enabled: draft.enabled,
              agentId: draft.agentId.trim() || null,
              sessionTarget:
                draft.sessionTarget.trim() || DEFAULT_MEMORY_AUDIT_SETTINGS.sessionTarget,
              model: draft.model.trim() || null,
              timezone: draft.timezone.trim() || null,
              daily: {
                enabled: draft.dailyEnabled,
                cron: draft.dailyCron.trim() || DEFAULT_MEMORY_AUDIT_SETTINGS.dailyCron,
              },
              weekly: {
                enabled: draft.weeklyEnabled,
                cron: draft.weeklyCron.trim() || DEFAULT_MEMORY_AUDIT_SETTINGS.weeklyCron,
              },
              delivery,
            },
          },
        },
      },
    },
  };
}

export function validateMemoryAuditSettings(
  draft: MemoryAuditSettingsDraft,
): MemoryAuditSettingsErrors {
  const errors: MemoryAuditSettingsErrors = {};
  const sessionTarget = draft.sessionTarget.trim();
  if (
    !sessionTarget ||
    (sessionTarget !== "main" &&
      sessionTarget !== "isolated" &&
      !sessionTarget.startsWith("session:"))
  ) {
    errors.sessionTarget = "memoryAudit.errors.sessionTarget";
  }
  if (draft.dailyEnabled && !draft.dailyCron.trim()) {
    errors.dailyCron = "memoryAudit.errors.dailyCron";
  }
  if (draft.weeklyEnabled && !draft.weeklyCron.trim()) {
    errors.weeklyCron = "memoryAudit.errors.weeklyCron";
  }
  if (draft.deliveryMode === "webhook") {
    const target = draft.deliveryTo.trim();
    if (!target) {
      errors.deliveryTo = "memoryAudit.errors.webhookRequired";
    } else if (!/^https?:\/\//i.test(target)) {
      errors.deliveryTo = "memoryAudit.errors.webhookInvalid";
    }
  }
  return errors;
}

export function memoryAuditSettingsDirty(
  state: Pick<MemoryAuditState, "memoryAuditSettingsDraft" | "memoryAuditSettingsOriginal">,
): boolean {
  return (
    JSON.stringify(state.memoryAuditSettingsDraft) !==
    JSON.stringify(state.memoryAuditSettingsOriginal)
  );
}

export function updateMemoryAuditSettingsDraft(
  state: MemoryAuditState,
  patch: Partial<MemoryAuditSettingsDraft>,
): void {
  state.memoryAuditSettingsDraft = { ...state.memoryAuditSettingsDraft, ...patch };
  state.memoryAuditSettingsMessage = null;
}

export function resetMemoryAuditSettingsDraft(state: MemoryAuditState): void {
  state.memoryAuditSettingsDraft = { ...state.memoryAuditSettingsOriginal };
  state.memoryAuditSettingsMessage = null;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePossiblyEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeFiniteInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function normalizeAction(value: unknown): MemoryAuditAction | null {
  return value === "add" || value === "edit" || value === "delete" || value === "move"
    ? value
    : null;
}

function normalizeKind(value: unknown): MemoryAuditSurfaceKind | null {
  return value === "agent-memory" ||
    value === "user-profile" ||
    value === "tool-notes" ||
    value === "shared-memory"
    ? value
    : null;
}

function normalizeStatus(value: unknown): MemoryAuditSuggestionStatus | null {
  return value === "pending" || value === "applied" || value === "rejected" || value === "conflict"
    ? value
    : null;
}

function normalizeTarget(value: unknown): MemoryAuditSuggestionTarget | null {
  const record = asRecord(value);
  const surfaceId = normalizeTrimmedString(record?.surfaceId);
  const kind = normalizeKind(record?.kind);
  const path = normalizeTrimmedString(record?.path);
  const workspaceDir = normalizeTrimmedString(record?.workspaceDir);
  if (!surfaceId || !kind || !path || !workspaceDir) {
    return null;
  }
  return {
    surfaceId,
    kind,
    path,
    workspaceDir,
    ...(normalizeTrimmedString(record?.agentId)
      ? { agentId: normalizeTrimmedString(record?.agentId) }
      : {}),
  };
}

function normalizeSource(value: unknown): MemoryAuditSuggestion["source"] | undefined {
  const record = asRecord(value);
  const target = normalizeTarget(record);
  const hash = normalizeTrimmedString(record?.hash);
  if (!target || !hash) {
    return undefined;
  }
  return {
    ...target,
    startLine: Math.max(1, normalizeFiniteInt(record?.startLine, 1)),
    endLine: Math.max(1, normalizeFiniteInt(record?.endLine, 1)),
    hash,
  };
}

function normalizeSuggestion(value: unknown): MemoryAuditSuggestion | null {
  const record = asRecord(value);
  const id = normalizeTrimmedString(record?.id);
  const status = normalizeStatus(record?.status);
  const action = normalizeAction(record?.action);
  const text = normalizePossiblyEmptyString(record?.text);
  const rationale = normalizeTrimmedString(record?.rationale);
  const target = normalizeTarget(record?.target);
  const createdAt = normalizeTrimmedString(record?.createdAt);
  const updatedAt = normalizeTrimmedString(record?.updatedAt);
  if (
    !id ||
    !status ||
    !action ||
    text === undefined ||
    (action !== "delete" && text.length === 0) ||
    !rationale ||
    !target ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    status,
    action,
    text,
    rationale,
    confidence: normalizeConfidence(record?.confidence),
    target,
    createdAt,
    updatedAt,
    ...(normalizeSource(record?.source) ? { source: normalizeSource(record?.source) } : {}),
    ...(normalizeTrimmedString(record?.reviewerAgentId)
      ? { reviewerAgentId: normalizeTrimmedString(record?.reviewerAgentId) }
      : {}),
    ...(normalizeTrimmedString(record?.appliedAt)
      ? { appliedAt: normalizeTrimmedString(record?.appliedAt) }
      : {}),
    ...(normalizeTrimmedString(record?.rejectedAt)
      ? { rejectedAt: normalizeTrimmedString(record?.rejectedAt) }
      : {}),
    ...(normalizeTrimmedString(record?.conflict)
      ? { conflict: normalizeTrimmedString(record?.conflict) }
      : {}),
  };
}

export function normalizeMemoryAuditSuggestions(value: unknown): MemoryAuditSuggestions {
  const record = asRecord(value);
  const suggestions = Array.isArray(record?.suggestions)
    ? record.suggestions
        .map((entry) => normalizeSuggestion(entry))
        .filter((entry): entry is MemoryAuditSuggestion => entry !== null)
    : [];
  return {
    ...(normalizeTrimmedString(record?.agentId)
      ? { agentId: normalizeTrimmedString(record?.agentId) }
      : {}),
    workspaces: normalizeStringArray(record?.workspaces),
    total: normalizeFiniteInt(record?.total, suggestions.length),
    pending: normalizeFiniteInt(
      record?.pending,
      suggestions.filter((entry) => entry.status === "pending").length,
    ),
    applied: normalizeFiniteInt(
      record?.applied,
      suggestions.filter((entry) => entry.status === "applied").length,
    ),
    rejected: normalizeFiniteInt(
      record?.rejected,
      suggestions.filter((entry) => entry.status === "rejected").length,
    ),
    conflict: normalizeFiniteInt(
      record?.conflict,
      suggestions.filter((entry) => entry.status === "conflict").length,
    ),
    suggestions,
  };
}

function hasGatewayMethod(state: MemoryAuditState, method: string): boolean | null {
  const methods = state.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

function methodUnavailableMessage(method: string): string {
  return `Memory Audit is unavailable on this Gateway. Missing method: ${method}`;
}

function memoryAuditSettingsSavedMessage(payload: ConfigPatchResult): string {
  if (payload.noop === true) {
    return "Memory Audit settings already matched the saved config.";
  }
  if (asRecord(payload.restart)) {
    return "Memory Audit settings saved. Gateway restart scheduled to reconcile audit schedules.";
  }
  return "Memory Audit settings saved. Restart the Gateway to reconcile audit schedules.";
}

export async function loadMemoryAuditSuggestions(state: MemoryAuditState): Promise<void> {
  if (!state.client || !state.connected || state.memoryAuditLoading) {
    return;
  }
  const method = "doctor.memory.auditSuggestions";
  if (hasGatewayMethod(state, method) === false) {
    state.memoryAuditSuggestions = null;
    state.memoryAuditError = methodUnavailableMessage(method);
    state.memoryAuditLoading = false;
    return;
  }
  state.memoryAuditLoading = true;
  state.memoryAuditError = null;
  try {
    const payload = await state.client.request(method, {});
    state.memoryAuditSuggestions = normalizeMemoryAuditSuggestions(payload);
  } catch (err) {
    state.memoryAuditError = String(err);
  } finally {
    state.memoryAuditLoading = false;
  }
}

export function applyMemoryAuditSettingsFromSnapshot(state: MemoryAuditState): void {
  const { pluginId, draft } = readMemoryAuditSettings(state.configSnapshot?.config ?? {});
  state.memoryAuditSettingsPluginId = pluginId;
  state.memoryAuditSettingsDraft = { ...draft };
  state.memoryAuditSettingsOriginal = { ...draft };
}

export async function loadMemoryAuditSettings(state: MemoryAuditState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.memoryAuditSettingsLoading = true;
  state.memoryAuditSettingsError = null;
  try {
    const snapshot = await state.client.request<ConfigSnapshot>("config.get", {});
    state.configSnapshot = snapshot;
    applyMemoryAuditSettingsFromSnapshot(state);
  } catch (err) {
    const message = String(err);
    state.memoryAuditSettingsError = message;
    state.lastError = message;
  } finally {
    state.memoryAuditSettingsLoading = false;
  }
}

export async function saveMemoryAuditSettings(state: MemoryAuditState): Promise<boolean> {
  if (!state.client || !state.connected || state.memoryAuditSettingsSaving) {
    return false;
  }
  const errors = validateMemoryAuditSettings(state.memoryAuditSettingsDraft);
  if (Object.keys(errors).length > 0) {
    state.memoryAuditSettingsMessage = {
      kind: "error",
      text: "Fix Memory Audit settings before saving.",
    };
    return false;
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.memoryAuditSettingsError = "Config hash missing; refresh and retry.";
    return false;
  }
  const pluginId = state.memoryAuditSettingsPluginId || DEFAULT_MEMORY_AUDIT_PLUGIN_ID;
  state.memoryAuditSettingsSaving = true;
  state.memoryAuditSettingsError = null;
  state.memoryAuditSettingsMessage = null;
  try {
    const patchResult = await state.client.request<ConfigPatchResult>("config.patch", {
      baseHash,
      raw: JSON.stringify(buildMemoryAuditConfigPatch(pluginId, state.memoryAuditSettingsDraft)),
      sessionKey: state.applySessionKey,
      note: "Memory Audit settings updated from the Audit tab.",
    });
    state.memoryAuditSettingsOriginal = { ...state.memoryAuditSettingsDraft };
    state.memoryAuditSettingsMessage = {
      kind: "success",
      text: memoryAuditSettingsSavedMessage(patchResult ?? {}),
    };
    await loadMemoryAuditSettings(state);
    return true;
  } catch (err) {
    const message = String(err);
    state.memoryAuditSettingsMessage = { kind: "error", text: message };
    state.memoryAuditSettingsError = message;
    state.lastError = message;
    return false;
  } finally {
    state.memoryAuditSettingsSaving = false;
  }
}

function buildActionMessage(action: "apply" | "reject", payload: MemoryAuditActionPayload): string {
  if (payload.conflict && typeof payload.conflict === "string") {
    return `Could not apply suggestion: ${payload.conflict}`;
  }
  if (action === "apply") {
    return payload.applied === false ? "Suggestion was not applied." : "Suggestion applied.";
  }
  return payload.rejected === false ? "Suggestion was not rejected." : "Suggestion rejected.";
}

function didAuditActionSucceed(
  action: "apply" | "reject",
  payload: MemoryAuditActionPayload,
): boolean {
  if (payload.conflict) {
    return false;
  }
  return action === "apply" ? payload.applied !== false : payload.rejected !== false;
}

export async function runMemoryAuditAction(
  state: MemoryAuditState,
  suggestion: MemoryAuditSuggestion,
  action: "apply" | "reject",
): Promise<void> {
  if (!state.client || !state.connected || state.memoryAuditActionId || state.memoryAuditLoading) {
    return;
  }
  if (suggestion.status !== "pending") {
    return;
  }
  const method = action === "apply" ? "doctor.memory.auditApply" : "doctor.memory.auditReject";
  if (hasGatewayMethod(state, method) === false) {
    state.memoryAuditActionMessage = {
      kind: "error",
      text: methodUnavailableMessage(method),
    };
    return;
  }
  state.memoryAuditActionId = suggestion.id;
  state.memoryAuditActionMessage = null;
  state.memoryAuditError = null;
  try {
    const payload = await state.client.request<MemoryAuditActionPayload>(method, {
      id: suggestion.id,
      workspaceDir: suggestion.target.workspaceDir,
    });
    state.memoryAuditActionMessage = {
      kind: didAuditActionSucceed(action, payload ?? {}) ? "success" : "error",
      text: buildActionMessage(action, payload ?? {}),
    };
    await loadMemoryAuditSuggestions(state);
  } catch (err) {
    state.memoryAuditActionMessage = {
      kind: "error",
      text: String(err),
    };
  } finally {
    state.memoryAuditActionId = null;
  }
}
