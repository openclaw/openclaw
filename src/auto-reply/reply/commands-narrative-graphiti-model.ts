/**
 * /narrativemodel and /graphitimodel commands.
 *
 * /narrativemodel                 - show current narrative model (agents.defaults.auxiliaryModel)
 * /narrativemodel <provider/model> - set narrative model
 * /narrativemodels                 - show provider/model picker buttons
 *
 * /graphitimodel                  - show current graphiti/observer model (agents.defaults.smallModel)
 * /graphitimodel <provider/model>  - set graphiti model
 * /graphitimodels                  - show provider/model picker buttons
 */

import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  buildModelAliasIndex,
  normalizeProviderId,
} from "../../agents/model-selection.js";
import {
  setConfigValueAtPath,
  unsetConfigValueAtPath,
  parseConfigPath,
} from "../../config/config-paths.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildAuxModelsKeyboard,
  buildAuxProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  type ModelPickerTarget,
  type ProviderInfo,
} from "../../telegram/model-buttons.js";
import type { ReplyPayload } from "../types.js";
import { buildModelsProviderData } from "./commands-models.js";
import type { CommandHandler } from "./commands-types.js";

type AuxTarget = Exclude<ModelPickerTarget, "main">;

const TARGET_CONFIG_KEY: Record<AuxTarget, string> = {
  narrative: "agents.defaults.auxiliaryModel",
  graphiti: "agents.defaults.smallModel",
};

const TARGET_LABEL: Record<AuxTarget, string> = {
  narrative: "Narrative model",
  graphiti: "Graphiti/observer model",
};

function getCurrentAuxModel(cfg: OpenClawConfig, target: AuxTarget): string | undefined {
  if (target === "narrative") {
    return cfg.agents?.defaults?.auxiliaryModel ?? undefined;
  }
  return cfg.agents?.defaults?.smallModel ?? undefined;
}

export async function resolveAuxModelCommandReply(params: {
  cfg: OpenClawConfig;
  target: AuxTarget;
  argText: string;
  surface?: string;
  agentDir?: string;
}): Promise<ReplyPayload | null> {
  const { cfg, target, surface } = params;
  const argText = params.argText.trim();
  const isTelegram = surface === "telegram";
  const label = TARGET_LABEL[target];
  const currentModel = getCurrentAuxModel(cfg, target);

  // No arg: show current model + browse button
  if (!argText) {
    const text = currentModel
      ? `${label}: \`${currentModel}\``
      : `${label}: (not set — using primary model)`;
    if (isTelegram) {
      const _command = target === "narrative" ? "narrativemodels" : "graphitimodels";
      return {
        text,
        channelData: {
          telegram: {
            buttons: [
              [
                {
                  text: "Browse providers",
                  callback_data: `${target === "narrative" ? "nm" : "gm"}_prov`,
                },
              ],
            ],
          },
        },
      };
    }
    return { text };
  }

  // "unset" keyword: remove the config key
  if (argText.toLowerCase() === "unset") {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return { text: "⚠️ Config file is invalid." };
    }
    const base = structuredClone(snapshot.parsed as Record<string, unknown>);
    const parsedPath = parseConfigPath(TARGET_CONFIG_KEY[target]);
    if (!parsedPath.ok || !parsedPath.path) {
      return { text: `⚠️ Internal error: invalid config path.` };
    }
    unsetConfigValueAtPath(base, parsedPath.path);
    const validated = validateConfigObjectWithPlugins(base);
    if (!validated.ok) {
      return { text: `⚠️ Config invalid after unset: ${validated.issues[0]?.message}` };
    }
    await writeConfigFile(validated.config);
    return { text: `✅ ${label} removed (will fall back to primary model).` };
  }

  // Resolve model ref
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: resolvedDefault.provider });
  const resolved = resolveModelRefFromString({
    raw: argText,
    defaultProvider: resolvedDefault.provider,
    aliasIndex,
  });

  if (!resolved) {
    return { text: `⚠️ Unknown model: ${argText}` };
  }

  const modelRef = `${resolved.ref.provider}/${resolved.ref.model}`;

  // Write to config
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return { text: "⚠️ Config file is invalid." };
  }
  const base = structuredClone(snapshot.parsed as Record<string, unknown>);
  const parsedPath = parseConfigPath(TARGET_CONFIG_KEY[target]);
  if (!parsedPath.ok || !parsedPath.path) {
    return { text: `⚠️ Internal error: invalid config path.` };
  }
  setConfigValueAtPath(base, parsedPath.path, modelRef);
  const validated = validateConfigObjectWithPlugins(base);
  if (!validated.ok) {
    return { text: `⚠️ Config invalid: ${validated.issues[0]?.message}` };
  }
  await writeConfigFile(validated.config);
  return { text: `✅ ${label} set to \`${modelRef}\`` };
}

export async function resolveAuxModelsCommandReply(params: {
  cfg: OpenClawConfig;
  target: AuxTarget;
  argText: string;
  surface?: string;
  agentDir?: string;
}): Promise<ReplyPayload | null> {
  const { cfg, target, surface } = params;
  const argText = params.argText.trim();
  const isTelegram = surface === "telegram";
  const label = TARGET_LABEL[target];
  const currentModel = getCurrentAuxModel(cfg, target);

  const { byProvider, providers } = await buildModelsProviderData(cfg);

  // No provider arg: show provider list
  if (!argText) {
    if (isTelegram && providers.length > 0) {
      const providerInfos: ProviderInfo[] = providers.map((p) => ({
        id: p,
        count: byProvider.get(p)?.size ?? 0,
      }));
      return {
        text: `Select provider for ${label}:`,
        channelData: { telegram: { buttons: buildAuxProviderKeyboard(providerInfos, target) } },
      };
    }
    const lines = [
      `${label} providers:`,
      ...providers.map((p) => `- ${p} (${byProvider.get(p)?.size ?? 0})`),
      "",
      `Use: /${target === "narrative" ? "narrativemodel" : "graphitimodel"} <provider/model>`,
    ];
    return { text: lines.join("\n") };
  }

  // Provider specified: show model list
  const provider = normalizeProviderId(argText.split(/\s+/)[0] ?? "");
  if (!byProvider.has(provider)) {
    return { text: `Unknown provider: ${provider}` };
  }
  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (isTelegram) {
    const pageSize = getModelsPageSize();
    const totalPages = calculateTotalPages(total, pageSize);
    return {
      text: `${label} — ${provider} (${total} models)`,
      channelData: {
        telegram: {
          buttons: buildAuxModelsKeyboard(
            { provider, models, currentModel, currentPage: 1, totalPages, pageSize },
            target,
          ),
        },
      },
    };
  }

  const lines = [`${label} — ${provider}:`, ...models.map((m) => `- ${provider}/${m}`)];
  return { text: lines.join("\n") };
}

export const handleNarrativeModelCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const body = params.command.commandBodyNormalized;
  const isModels = /^\/narrativemodels\b/i.test(body);
  const isModel = /^\/narrativemodel\b/i.test(body) && !isModels;
  if (!isModel && !isModels) {
    return null;
  }

  const agentId =
    params.agentId ?? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const agentDir = resolveAgentDir(params.cfg, agentId);

  if (isModels) {
    const argText = body.replace(/^\/narrativemodels\b/i, "").trim();
    const reply = await resolveAuxModelsCommandReply({
      cfg: params.cfg,
      target: "narrative",
      argText,
      surface: params.ctx.Surface,
      agentDir,
    });
    return reply ? { reply, shouldContinue: false } : null;
  }

  const argText = body.replace(/^\/narrativemodel\b/i, "").trim();
  const reply = await resolveAuxModelCommandReply({
    cfg: params.cfg,
    target: "narrative",
    argText,
    surface: params.ctx.Surface,
    agentDir,
  });
  return reply ? { reply, shouldContinue: false } : null;
};

export const handleGraphitiModelCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const body = params.command.commandBodyNormalized;
  const isModels = /^\/graphitimodels\b/i.test(body);
  const isModel = /^\/graphitimodel\b/i.test(body) && !isModels;
  if (!isModel && !isModels) {
    return null;
  }

  const agentId =
    params.agentId ?? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const agentDir = resolveAgentDir(params.cfg, agentId);

  if (isModels) {
    const argText = body.replace(/^\/graphitimodels\b/i, "").trim();
    const reply = await resolveAuxModelsCommandReply({
      cfg: params.cfg,
      target: "graphiti",
      argText,
      surface: params.ctx.Surface,
      agentDir,
    });
    return reply ? { reply, shouldContinue: false } : null;
  }

  const argText = body.replace(/^\/graphitimodel\b/i, "").trim();
  const reply = await resolveAuxModelCommandReply({
    cfg: params.cfg,
    target: "graphiti",
    argText,
    surface: params.ctx.Surface,
    agentDir,
  });
  return reply ? { reply, shouldContinue: false } : null;
};
