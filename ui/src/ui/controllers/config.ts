import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot, ConfigUiHints } from "../types.ts";
import type { JsonSchema } from "../views/config-form.shared.ts";
import { coerceFormValues } from "./config/form-coerce.ts";
import {
  cloneConfigObject,
  removePathValue,
  serializeConfigForm,
  setPathValue,
} from "./config/form-utils.ts";

export type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  lastError: string | null;
};

export async function loadConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<ConfigSnapshot>("config.get", {});
    applyConfigSnapshot(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configLoading = false;
  }
}

export async function loadConfigSchema(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  state.configSchemaLoading = true;
  try {
    const res = await state.client.request<ConfigSchemaResponse>("config.schema", {});
    applyConfigSchema(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSchemaLoading = false;
  }
}

export function applyConfigSchema(state: ConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

export function applyConfigSnapshot(state: ConfigState, snapshot: ConfigSnapshot) {
  state.configSnapshot = snapshot;
  const rawFromSnapshot =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : snapshot.config && typeof snapshot.config === "object"
        ? serializeConfigForm(snapshot.config)
        : state.configRaw;
  if (!state.configFormDirty || state.configFormMode === "raw") {
    state.configRaw = rawFromSnapshot;
  } else if (state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!state.configFormDirty) {
    state.configForm = cloneConfigObject(snapshot.config ?? {});
    state.configFormOriginal = cloneConfigObject(snapshot.config ?? {});
    state.configRawOriginal = rawFromSnapshot;
  }
}

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

function setDiscordAllowFromItemsToString(
  schemaNode: Record<string, unknown> | null | undefined,
): void {
  if (!schemaNode || typeof schemaNode !== "object") {
    return;
  }
  const allowFrom =
    typeof schemaNode.allowFrom === "object" &&
    schemaNode.allowFrom &&
    !Array.isArray(schemaNode.allowFrom)
      ? (schemaNode.allowFrom as Record<string, unknown>)
      : null;
  if (allowFrom && allowFrom.type === "array") {
    allowFrom.items = { type: "string" };
  }
}

function normalizeDiscordAllowFromSchema(schema: JsonSchema): JsonSchema {
  const next = cloneConfigObject(schema) as JsonSchema;
  const rootProperties =
    next.properties && typeof next.properties === "object" ? next.properties : undefined;
  const channels =
    rootProperties?.channels && typeof rootProperties.channels === "object"
      ? (rootProperties.channels as Record<string, unknown>)
      : null;
  const channelProperties =
    channels?.properties && typeof channels.properties === "object"
      ? (channels.properties as Record<string, unknown>)
      : null;
  const discord =
    channelProperties?.discord && typeof channelProperties.discord === "object"
      ? (channelProperties.discord as Record<string, unknown>)
      : null;
  const discordProperties =
    discord?.properties && typeof discord.properties === "object"
      ? (discord.properties as Record<string, unknown>)
      : null;
  if (!discordProperties) {
    return next;
  }

  setDiscordAllowFromItemsToString(discordProperties);

  const dm =
    discordProperties.dm && typeof discordProperties.dm === "object"
      ? (discordProperties.dm as Record<string, unknown>)
      : null;
  const dmProperties =
    dm?.properties && typeof dm.properties === "object"
      ? (dm.properties as Record<string, unknown>)
      : null;
  if (dmProperties) {
    setDiscordAllowFromItemsToString(dmProperties);
  }

  const accounts =
    discordProperties.accounts && typeof discordProperties.accounts === "object"
      ? (discordProperties.accounts as Record<string, unknown>)
      : null;
  const accountSchema =
    accounts?.additionalProperties &&
    typeof accounts.additionalProperties === "object" &&
    !Array.isArray(accounts.additionalProperties)
      ? (accounts.additionalProperties as Record<string, unknown>)
      : null;
  const accountProperties =
    accountSchema?.properties && typeof accountSchema.properties === "object"
      ? (accountSchema.properties as Record<string, unknown>)
      : null;
  if (accountProperties) {
    setDiscordAllowFromItemsToString(accountProperties);
    const accountDm =
      accountProperties.dm && typeof accountProperties.dm === "object"
        ? (accountProperties.dm as Record<string, unknown>)
        : null;
    const accountDmProperties =
      accountDm?.properties && typeof accountDm.properties === "object"
        ? (accountDm.properties as Record<string, unknown>)
        : null;
    if (accountDmProperties) {
      setDiscordAllowFromItemsToString(accountDmProperties);
    }
  }

  return next;
}

function normalizeQuotedStringEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Preserve the original value when it is not a JSON string literal.
    }
  }
  return value;
}

function normalizeDiscordAllowFromList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return String(entry);
    }
    if (typeof entry === "string") {
      return normalizeQuotedStringEntry(entry);
    }
    return entry;
  });
}

function normalizeDiscordAllowFromConfig(value: Record<string, unknown>): Record<string, unknown> {
  const next = cloneConfigObject(value);
  const channels =
    typeof next.channels === "object" && next.channels && !Array.isArray(next.channels)
      ? (next.channels as Record<string, unknown>)
      : null;
  const discord =
    typeof channels?.discord === "object" && channels.discord && !Array.isArray(channels.discord)
      ? (channels.discord as Record<string, unknown>)
      : null;
  if (!discord) {
    return next;
  }

  if ("allowFrom" in discord) {
    discord.allowFrom = normalizeDiscordAllowFromList(discord.allowFrom);
  }

  const dm =
    typeof discord.dm === "object" && discord.dm && !Array.isArray(discord.dm)
      ? (discord.dm as Record<string, unknown>)
      : null;
  if (dm && "allowFrom" in dm) {
    dm.allowFrom = normalizeDiscordAllowFromList(dm.allowFrom);
  }

  const accounts =
    typeof discord.accounts === "object" && discord.accounts && !Array.isArray(discord.accounts)
      ? (discord.accounts as Record<string, unknown>)
      : null;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      if (typeof account !== "object" || !account || Array.isArray(account)) {
        continue;
      }
      const accountRecord = account as Record<string, unknown>;
      if ("allowFrom" in accountRecord) {
        accountRecord.allowFrom = normalizeDiscordAllowFromList(accountRecord.allowFrom);
      }
      const accountDm =
        typeof accountRecord.dm === "object" && accountRecord.dm && !Array.isArray(accountRecord.dm)
          ? (accountRecord.dm as Record<string, unknown>)
          : null;
      if (accountDm && "allowFrom" in accountDm) {
        accountDm.allowFrom = normalizeDiscordAllowFromList(accountDm.allowFrom);
      }
    }
  }

  return next;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
function serializeFormForSubmit(state: ConfigState): string {
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = asJsonSchema(state.configSchema);
  const formSchema = schema ? normalizeDiscordAllowFromSchema(schema) : null;
  const form = formSchema
    ? (coerceFormValues(state.configForm, formSchema) as Record<string, unknown>)
    : state.configForm;
  return serializeConfigForm(normalizeDiscordAllowFromConfig(form));
}

export async function saveConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configSaving = true;
  state.lastError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    await state.client.request("config.set", { raw, baseHash });
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSaving = false;
  }
}

export async function applyConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configApplying = true;
  state.lastError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    await state.client.request("config.apply", {
      raw,
      baseHash,
      sessionKey: state.applySessionKey,
    });
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configApplying = false;
  }
}

export async function runUpdate(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.updateRunning = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{
      ok?: boolean;
      result?: { status?: string; reason?: string };
    }>("update.run", {
      sessionKey: state.applySessionKey,
    });
    if (res && res.ok === false) {
      const status = res.result?.status ?? "error";
      const reason = res.result?.reason ?? "Update failed.";
      state.lastError = `Update ${status}: ${reason}`;
    }
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.updateRunning = false;
  }
}

export function updateConfigFormValue(
  state: ConfigState,
  path: Array<string | number>,
  value: unknown,
) {
  const base = cloneConfigObject(state.configForm ?? state.configSnapshot?.config ?? {});
  setPathValue(base, path, value);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}

export function removeConfigFormValue(state: ConfigState, path: Array<string | number>) {
  const base = cloneConfigObject(state.configForm ?? state.configSnapshot?.config ?? {});
  removePathValue(base, path);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}

export function findAgentConfigEntryIndex(
  config: Record<string, unknown> | null,
  agentId: string,
): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const list = (config as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      (entry as { id?: string }).id === normalizedAgentId,
  );
}

export function ensureAgentConfigEntry(state: ConfigState, agentId: string): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const source =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const existingIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (existingIndex >= 0) {
    return existingIndex;
  }
  const list = (source as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  const nextIndex = Array.isArray(list) ? list.length : 0;
  updateConfigFormValue(state, ["agents", "list", nextIndex, "id"], normalizedAgentId);
  return nextIndex;
}

export async function openConfigFile(state: ConfigState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("config.openFile", {});
  } catch {
    const path = state.configSnapshot?.path;
    if (path) {
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        // ignore
      }
    }
  }
}
