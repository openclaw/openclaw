import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-ref.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginProviders } from "../plugins/providers.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export async function runExtensionHostProviderModelSelectedHook(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const parsed = parseModelRef(params.model, DEFAULT_PROVIDER);
  if (!parsed) {
    return;
  }

  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const provider = providers.find(
    (entry) => normalizeProviderId(entry.id) === normalizeProviderId(parsed.provider),
  );
  if (!provider?.onModelSelected) {
    return;
  }

  await provider.onModelSelected({
    config: params.config,
    model: params.model,
    prompter: params.prompter,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
}
