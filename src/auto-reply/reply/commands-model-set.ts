import type { CommandArgChoice, CommandArgChoiceContext } from "../commands-registry.types.js";
import type { CommandHandler } from "./commands-types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
} from "../../agents/model-selection.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { updateSessionStore } from "../../config/sessions.js";
import { buildModelPickerItems } from "./directive-handling.model-picker.js";
import { buildModelPickerCatalog } from "./directive-handling.model.js";
import { resolveModelDirectiveSelection } from "./model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";

const MODEL_PICK_MAX = 20;

let cachedModelCatalog: ModelCatalogEntry[] | null = null;
let catalogLoading: Promise<ModelCatalogEntry[]> | null = null;

async function loadModelCatalogCached(cfg: OpenClawConfig): Promise<ModelCatalogEntry[]> {
  if (cachedModelCatalog) {
    return cachedModelCatalog;
  }

  if (catalogLoading) {
    await catalogLoading;
    return cachedModelCatalog ?? [];
  }

  catalogLoading = loadModelCatalog({ config: cfg })
    .then((catalog) => {
      if (catalog.length > 0) {
        cachedModelCatalog = catalog;
      }
      return catalog;
    })
    .catch(() => [])
    .finally(() => {
      catalogLoading = null;
    });

  return await catalogLoading;
}

function ensureModelCatalog(cfg: OpenClawConfig) {
  void loadModelCatalogCached(cfg);
}

function listPickerChoices(params: {
  cfg: OpenClawConfig;
  limit?: number;
}): CommandArgChoice[] {
  const { cfg, limit } = params;
  ensureModelCatalog(cfg);
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
  });
  const catalog = cachedModelCatalog ?? [];
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
  });
  const pickerCatalog = buildModelPickerCatalog({
    cfg,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    aliasIndex,
    allowedModelCatalog: allowed.allowedCatalog,
  });
  const items = buildModelPickerItems(pickerCatalog);
  const choices = items.map((item) => {
    const value = `${item.provider}/${item.model}`;
    return { value, label: value };
  });
  if (typeof limit === "number") {
    return choices.slice(0, Math.max(0, limit));
  }
  return choices;
}

export function listModelPickerChoices(context: CommandArgChoiceContext): CommandArgChoice[] {
  const cfg = context.cfg;
  if (!cfg) {
    return [];
  }
  if (context.command.key === "model-set") {
    return listPickerChoices({ cfg, limit: MODEL_PICK_MAX });
  }
  return listPickerChoices({ cfg });
}

export const handleModelSetCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  const match = normalized.match(/^\/model-set(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /model-set from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const raw = match[1]?.trim() ?? "";
  if (!raw) {
    return {
      shouldContinue: false,
      reply: { text: `Usage: /model-set <provider/model>` },
    };
  }

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: resolvedDefault.provider,
  });
  const catalog = await loadModelCatalogCached(params.cfg);
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
  });
  const resolved = resolveModelDirectiveSelection({
    raw,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    aliasIndex,
    allowedModelKeys: allowed.allowedKeys,
  });
  if (resolved.error) {
    return { shouldContinue: false, reply: { text: resolved.error } };
  }
  if (!resolved.selection) {
    return { shouldContinue: false, reply: { text: "No model selected." } };
  }

  const selection = resolved.selection;
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    applyModelOverrideToSessionEntry({ entry: params.sessionEntry, selection });
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    if (params.storePath) {
      await updateSessionStore(params.storePath, (store) => {
        store[params.sessionKey] = params.sessionEntry as SessionEntry;
      });
    }
    const label = `${selection.provider}/${selection.model}`;
    enqueueSystemEvent(
      selection.alias ? `Model switched to ${selection.alias} (${label}).` : `Model switched to ${label}.`,
      { sessionKey: params.sessionKey, contextKey: `model:${label}` },
    );
  }

  const label = `${selection.provider}/${selection.model}`;
  const labelWithAlias = selection.alias ? `${selection.alias} (${label})` : label;
  const text = selection.isDefault
    ? `Model reset to default (${labelWithAlias}).`
    : `Model set to ${labelWithAlias}.`;
  return { shouldContinue: false, reply: { text } };
};
