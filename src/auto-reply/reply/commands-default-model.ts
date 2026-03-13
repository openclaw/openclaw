import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveModelRefFromString,
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveConfigWriteTargetFromPath,
} from "../../channels/plugins/config-writes.js";
import { normalizeChannelId } from "../../channels/registry.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import type { ButtonRow } from "../../telegram/model-buttons.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { buildModelsProviderData } from "./commands-models.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handle /default_model command.
 * - Without args: show current default model from config (with picker on Telegram)
 * - With args: set default model in config file (persists across restarts)
 */
export const handleDefaultModelCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const commandBody = params.command.commandBodyNormalized.trim();
  if (!commandBody.toLowerCase().startsWith("/default_model")) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/default_model");
  if (unauthorized) {
    return unauthorized;
  }

  // Extract model argument (everything after /default_model), preserving case
  const modelArg = commandBody.slice("/default_model".length).trim();

  // Read current config
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Config file is invalid; fix it before using /default_model." },
    };
  }

  const cfg = snapshot.parsed as Record<string, unknown>;
  const agentsDefaults = (cfg.agents as Record<string, unknown> | undefined)?.defaults as
    | Record<string, unknown>
    | undefined;
  const modelConfig = agentsDefaults?.model as Record<string, unknown> | string | undefined;

  // Get current default model
  const currentDefault =
    typeof modelConfig === "string"
      ? modelConfig
      : (modelConfig as Record<string, unknown>)?.primary
        ? String((modelConfig as Record<string, unknown>).primary)
        : "not set";

  const isTelegram = params.command.channel === "telegram";

  // If no args, show model picker (provider list) on Telegram, text fallback elsewhere
  if (!modelArg) {
    let providerButtons: ButtonRow[] = [];

    // Only build buttons for Telegram
    if (isTelegram) {
      try {
        const agentId = resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: params.cfg,
        });
        const modelData = await buildModelsProviderData(params.cfg, agentId);
        const { byProvider, providers } = modelData;

        if (providers.length > 0) {
          const rows: ButtonRow[] = [];
          for (let i = 0; i < providers.length; i += 2) {
            const row: ButtonRow = [];
            for (const prov of providers.slice(i, i + 2)) {
              const count = byProvider.get(prov)?.size ?? 0;
              row.push({
                text: `${prov} (${count})`,
                callback_data: `defmdl_list_${prov}_1`,
              });
            }
            rows.push(row);
          }
          providerButtons = rows;
        }
      } catch {
        // Fall back to text if provider data fails
      }
    }

    const showPicker = isTelegram && providerButtons.length > 0;
    const text = [
      `📋 **Default model (config):** \`${currentDefault}\``,
      "",
      showPicker
        ? "Select a provider to choose default model:"
        : "Usage: `/default_model <model-id>`",
      !showPicker ? "Example: `/default_model openrouter/stepfun/step-3.5-flash:free`" : "",
      "",
      "This sets the default model in the config file.",
      "Changes persist across restarts.",
    ]
      .filter(Boolean)
      .join("\n");

    const reply: ReplyPayload = {
      text,
      ...(showPicker ? { channelData: { telegram: { buttons: providerButtons } } } : {}),
    };
    return { shouldContinue: false, reply };
  }

  // Check config write policy before persisting
  const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
  const writeAuth = authorizeConfigWrite({
    cfg: params.cfg,
    origin: { channelId, accountId: params.ctx.AccountId },
    target: resolveConfigWriteTargetFromPath(["agents", "defaults", "model"]),
    allowBypass: canBypassConfigWritePolicy({
      channel: params.command.channel,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
    }),
  });
  if (!writeAuth.allowed) {
    return {
      shouldContinue: false,
      reply: {
        text: formatConfigWriteDeniedMessage({
          result: writeAuth,
          fallbackChannelId: channelId,
        }),
      },
    };
  }

  // Validate and normalize the model reference
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const resolvedDefault = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: resolvedDefault.provider,
  });

  const resolved = resolveModelRefFromString({
    raw: modelArg,
    defaultProvider: resolvedDefault.provider,
    aliasIndex,
  });

  if (!resolved) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Invalid model: \`${modelArg}\`\n\nUse format: \`provider/model\` or a known model alias.`,
      },
    };
  }

  const normalizedModel = `${resolved.ref.provider}/${resolved.ref.model}`;

  // Update config: set agents.defaults.model.primary
  const configBase = structuredClone(cfg);
  const agentsSection = (configBase.agents ??= {}) as Record<string, unknown>;
  const defaultsSection = (agentsSection.defaults ??= {}) as Record<string, unknown>;
  const modelSection = (defaultsSection.model ??= {} as Record<string, unknown>);

  if (typeof modelSection === "object" && modelSection !== null) {
    (modelSection as Record<string, unknown>).primary = normalizedModel;
  } else {
    defaultsSection.model = { primary: normalizedModel };
  }

  // Write config file
  try {
    await writeConfigFile(configBase);
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Failed to write config: ${String(err)}`,
      },
    };
  }

  const reply: ReplyPayload = {
    text: [
      `✅ **Default model updated!**`,
      "",
      `**Before:** \`${currentDefault}\``,
      `**After:** \`${normalizedModel}\``,
      "",
      "• Config file updated (persists across restarts)",
      "• New sessions will use this model by default",
      "• Current session model unchanged (use `/model` to change)",
    ].join("\n"),
  };

  return { shouldContinue: false, reply };
};
