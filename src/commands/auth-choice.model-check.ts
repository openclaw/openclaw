import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolveAgentModelPrimary } from "../agents/agent-scope.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { isCliProvider, resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./openai-codex-model-default.js";

function isCliCommandResolvable(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed);
  }
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [trimmed], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

export async function warnIfModelConfigLooksOff(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string },
) {
  const agentModelOverride = options?.agentId
    ? resolveAgentModelPrimary(config, options.agentId)
    : undefined;
  const configWithModel =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              model: {
                ...(typeof config.agents?.defaults?.model === "object"
                  ? config.agents.defaults.model
                  : undefined),
                primary: agentModelOverride,
              },
            },
          },
        }
      : config;
  const ref = resolveConfiguredModelRef({
    cfg: configWithModel,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warnings: string[] = [];
  const store = ensureAuthProfileStore(options?.agentDir);
  const cliProvider = isCliProvider(ref.provider, configWithModel);

  if (cliProvider) {
    const backend = resolveCliBackendConfig(ref.provider, configWithModel);
    if (!backend) {
      warnings.push(
        `CLI backend "${ref.provider}" is missing or invalid. Configure agents.defaults.cliBackends["${ref.provider}"].command.`,
      );
    } else if (!isCliCommandResolvable(backend.config.command)) {
      warnings.push(
        `CLI backend command not found: ${backend.config.command}. Install it or set an absolute command path in agents.defaults.cliBackends["${backend.id}"].command.`,
      );
    }
  } else {
    const catalog = await loadModelCatalog({
      config: configWithModel,
      useCache: false,
    });
    if (catalog.length > 0) {
      const known = catalog.some(
        (entry) => entry.provider === ref.provider && entry.id === ref.model,
      );
      if (!known) {
        warnings.push(
          `Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`,
        );
      }
    }

    const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
    const envKey = resolveEnvApiKey(ref.provider);
    const customKey = getCustomProviderApiKey(config, ref.provider);
    if (!hasProfile && !envKey && !customKey) {
      warnings.push(
        `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`,
      );
    }
  }

  if (ref.provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      warnings.push(
        `Detected OpenAI Codex OAuth. Consider setting agents.defaults.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`,
      );
    }
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}
