import type { OpenClawConfig } from "../config/config.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";

export type SetupMorphOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
};

type MorphFeatureChoice = "basic" | "enhanced";

function getMorphApiKey(config: OpenClawConfig): unknown {
  return (
    config.agents?.defaults?.compaction?.morphApiKey ??
    config.agents?.defaults?.codebaseSearch?.morphApiKey
  );
}

function hasMorphConfigured(config: OpenClawConfig): boolean {
  return (
    config.agents?.defaults?.compaction?.provider === "morph" ||
    hasConfiguredSecretInput(getMorphApiKey(config)) ||
    Boolean(process.env.MORPH_API_KEY?.trim())
  );
}

function applyMorphConfig(
  config: OpenClawConfig,
  apiKey: string,
  enhanced: boolean,
): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        compaction: {
          ...config.agents?.defaults?.compaction,
          provider: enhanced ? "morph" : undefined,
          ...(enhanced ? { morphApiKey: apiKey } : {}),
        },
        codebaseSearch: {
          ...config.agents?.defaults?.codebaseSearch,
          enabled: enhanced,
          morphApiKey: apiKey,
        },
      },
    },
  };
}

function enableMorphProvider(config: OpenClawConfig, enhanced: boolean): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        compaction: {
          ...config.agents?.defaults?.compaction,
          provider: enhanced ? "morph" : undefined,
        },
        codebaseSearch: {
          ...config.agents?.defaults?.codebaseSearch,
          enabled: enhanced,
        },
      },
    },
  };
}

export async function setupMorph(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupMorphOptions,
): Promise<OpenClawConfig> {
  const envAvailable = Boolean(process.env.MORPH_API_KEY?.trim());
  const keyConfigured = hasConfiguredSecretInput(getMorphApiKey(config));
  const alreadyMorph = config.agents?.defaults?.compaction?.provider === "morph";

  if (opts?.quickstartDefaults && hasMorphConfigured(config)) {
    if (alreadyMorph && keyConfigured) {
      return config;
    }
    const existingKey = normalizeSecretInputString(getMorphApiKey(config));
    if (existingKey) {
      return applyMorphConfig(config, existingKey, true);
    }
    if (envAvailable) {
      return enableMorphProvider(config, true);
    }
    return config;
  }

  const choice = await prompter.select<MorphFeatureChoice>({
    message: "Morph features",
    options: [
      {
        value: "basic" as const,
        label: "Basic",
        hint: "Agent only remembers a short description of what happened previously",
      },
      {
        value: "enhanced" as const,
        label: "Enhanced (Compaction + WarpGrep)",
        hint: "Fast compaction + AI-powered codebase search",
      },
    ],
    initialValue: hasMorphConfigured(config) ? "enhanced" : "basic",
  });

  if (choice === "basic") {
    return enableMorphProvider(config, false);
  }

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    await prompter.note(
      [
        "Env-based secret mode — OpenClaw will read the API key from the environment at runtime.",
        `Env var: MORPH_API_KEY${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : ["Set MORPH_API_KEY in the Gateway environment."]),
      ].join("\n"),
      "Morph",
    );
    return enableMorphProvider(config, true);
  }

  await prompter.note(
    [
      "Morph features require an API key.",
      "Get your key at: https://www.morphllm.com/dashboard/api-keys",
    ].join("\n"),
    "Morph",
  );

  const keyInput = await prompter.text({
    message: keyConfigured
      ? "Morph API key (leave blank to keep current)"
      : envAvailable
        ? "Morph API key (leave blank to use env var)"
        : "Morph API key",
    placeholder: keyConfigured ? "Leave blank to keep current" : "morph-...",
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    return applyMorphConfig(config, key, true);
  }

  const existingKey = normalizeSecretInputString(getMorphApiKey(config));
  if (existingKey) {
    return applyMorphConfig(config, existingKey, true);
  }

  if (envAvailable) {
    return enableMorphProvider(config, true);
  }

  await prompter.note(
    [
      "No API key provided — disabling Morph features.",
      "You can set this up later with: openclaw configure",
    ].join("\n"),
    "Morph",
  );

  return config;
}
