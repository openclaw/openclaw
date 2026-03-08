import { Type } from "@sinclair/typebox";
import {
  type AmbiguousCandidate,
  type ModelDirectiveSelection,
  resolveModelDirectiveSelection,
} from "../../auto-reply/reply/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { loadModelCatalog } from "../model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SwitchModelToolSchema = Type.Object({
  model: Type.String(),
});

async function applyAndRespond(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolvedKey: string;
  entry: SessionEntry;
  sessionKey: string;
  selection: ModelDirectiveSelection;
  previousModel: string;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const nextEntry: SessionEntry = { ...params.entry };
  const applied = applyModelOverrideToSessionEntry({
    entry: nextEntry,
    selection: params.selection,
  });

  if (applied.updated) {
    params.store[params.resolvedKey] = nextEntry;
    await updateSessionStore(params.storePath, (s) => {
      s[params.resolvedKey] = nextEntry;
    });
  }

  const newModel = `${params.selection.provider}/${params.selection.model}`;
  const aliasHint = params.selection.alias ? ` (alias: ${params.selection.alias})` : "";

  enqueueSystemEvent(`Model switched to ${newModel}${aliasHint}`, {
    sessionKey: params.sessionKey,
  });

  const text = params.selection.isDefault
    ? `Model reset to default: ${newModel}`
    : `Model switched: ${params.previousModel} → ${newModel}${aliasHint}`;

  return {
    content: [{ type: "text", text }],
    details: {
      ok: true,
      previousModel: params.previousModel,
      newModel,
      alias: params.selection.alias,
      isDefault: params.selection.isDefault,
    },
  };
}

function formatAmbiguousResult(
  raw: string,
  candidates: AmbiguousCandidate[],
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const lines = candidates.map((c) => {
    const alias = c.alias ? ` (alias: ${c.alias})` : "";
    return `- ${c.provider}/${c.model}${alias}`;
  });
  const text = [
    `Multiple models match "${raw}". Please ask the user which one they want:`,
    ...lines,
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      ok: false,
      ambiguous: true,
      candidates: candidates.map((c) => ({
        provider: c.provider,
        model: c.model,
        alias: c.alias,
      })),
    },
  };
}

export function createSwitchModelTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Switch Model",
    name: "switch_model",
    description:
      "Switch the AI model for this session. When the user asks to change/switch models (e.g. 'use kimi', 'switch to sonnet', 'change model to gpt-4o'), call this tool. Accepts aliases, partial names, or full provider/model. Use model='default' to reset to configured default. Takes effect from the next message.",
    parameters: SwitchModelToolSchema,
    ownerOnly: true,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = opts?.agentSessionKey;
      if (!sessionKey?.trim()) {
        throw new Error("sessionKey required");
      }

      const raw = readStringParam(params, "model")?.trim();
      if (!raw) {
        throw new Error("model parameter is required");
      }

      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);

      const internalKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
      const entryByInternal = store[internalKey];
      const entryByRaw = store[sessionKey];
      const entry = entryByInternal ?? entryByRaw;
      const resolvedKey = entryByInternal ? internalKey : sessionKey;
      if (!entry) {
        throw new Error(`Unknown session: ${sessionKey}`);
      }

      const configured = resolveDefaultModelForAgent({ cfg, agentId });
      const defaultProvider = configured.provider;
      const defaultModel = configured.model;
      const currentProvider = entry.providerOverride?.trim() || defaultProvider;
      const currentModel = entry.modelOverride?.trim() || defaultModel;
      const previousModel = `${currentProvider}/${currentModel}`;

      if (raw.toLowerCase() === "default" || raw.toLowerCase() === "reset") {
        return applyAndRespond({
          storePath,
          store,
          resolvedKey,
          entry,
          sessionKey,
          selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          previousModel,
        });
      }

      const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });
      const catalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({ cfg, catalog, defaultProvider, defaultModel });

      // Exact + alias resolution first
      const explicit = resolveModelRefFromString({ raw, defaultProvider, aliasIndex });
      if (explicit) {
        const key = modelKey(explicit.ref.provider, explicit.ref.model);
        if (allowed.allowedKeys.size === 0 || allowed.allowedKeys.has(key)) {
          return applyAndRespond({
            storePath,
            store,
            resolvedKey,
            entry,
            sessionKey,
            selection: {
              provider: explicit.ref.provider,
              model: explicit.ref.model,
              isDefault:
                explicit.ref.provider === defaultProvider && explicit.ref.model === defaultModel,
              ...(explicit.alias ? { alias: explicit.alias } : {}),
            },
            previousModel,
          });
        }
      }

      // Fuzzy match with ambiguity detection — same core as /model directive
      const fuzzy = resolveModelDirectiveSelection({
        raw,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys: allowed.allowedKeys,
        detectAmbiguity: true,
      });

      if (fuzzy.error) {
        throw new Error(fuzzy.error);
      }
      if (fuzzy.ambiguousCandidates) {
        return formatAmbiguousResult(raw, fuzzy.ambiguousCandidates);
      }
      if (fuzzy.selection) {
        return applyAndRespond({
          storePath,
          store,
          resolvedKey,
          entry,
          sessionKey,
          selection: fuzzy.selection,
          previousModel,
        });
      }

      throw new Error(
        `Could not resolve model "${raw}". Use /models to list providers, or /models <provider> to list models.`,
      );
    },
  };
}
