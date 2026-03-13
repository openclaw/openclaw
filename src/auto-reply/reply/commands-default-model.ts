import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveModelRefFromString,
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import type { ButtonRow } from "../../telegram/model-buttons.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { buildModelsProviderData } from "./commands-models.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handle /defaultModel command.
 * - Without args: show current default model from config
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
      reply: { text: "⚠️ Config file is invalid; fix it before using /defaultModel." },
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

  // If no args, show model picker (provider list)
  if (!modelArg) {
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });

    let providerButtons: ButtonRow[] = [];
    try {
      const modelData = await buildModelsProviderData(params.cfg, agentId);
      const { byProvider, providers } = modelData;

      if (providers.length > 0) {
        // Build provider buttons with defmdl_ prefix
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
      // If we can't build provider data, fall back to text
    }

    const text = [
      `📋 **Default model (config):** \`${currentDefault}\``,
      "",
      providerButtons.length > 0
        ? "Select a provider to choose default model:"
        : "Usage: `/default_model <model-id>`",
      providerButtons.length === 0
        ? "Example: `/default_model openrouter/stepfun/step-3.5-flash:free`"
        : "",
      "",
      "This sets the default model in the config file.",
      "Changes persist across restarts.",
    ]
      .filter(Boolean)
      .join("\n");

    const reply: ReplyPayload = {
      text,
      ...(providerButtons.length > 0
        ? { channelData: { telegram: { buttons: providerButtons } } }
        : {}),
    };
    return { shouldContinue: false, reply };
  }

  // Validate and normalize the model reference
  const resolvedDefault = resolveDefaultModelForAgent({ cfg: params.cfg });
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
