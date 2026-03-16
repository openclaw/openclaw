import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { buildProviderAuthRecoveryHint } from "./provider-auth-guidance.js";

export async function warnIfModelConfigLooksOff(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string },
) {
  const ref = resolveDefaultModelForAgent({
    cfg: config,
    agentId: options?.agentId,
  });
  const warnings: string[] = [];
  const catalog = await loadModelCatalog({
    config,
    useCache: false,
  });
  if (catalog.length > 0) {
    const known = catalog.some(
      (entry) => entry.provider === ref.provider && entry.id === ref.model,
    );
    if (!known) {
      warnings.push(
        `未找到模型：${ref.provider}/${ref.model}。请更新 agents.defaults.model，或运行 /models list。`,
      );
    }
  }

  const store = ensureAuthProfileStore(options?.agentDir);
  const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
  const envKey = resolveEnvApiKey(ref.provider);
  const hasCustomKey = hasUsableCustomProviderApiKey(config, ref.provider);
  if (!hasProfile && !envKey && !hasCustomKey) {
    warnings.push(
      `提供方 "${ref.provider}" 尚未配置认证。在补充凭证前，智能体可能无法正常工作。${buildProviderAuthRecoveryHint(
        {
          provider: ref.provider,
          config,
          includeEnvVar: true,
        },
      )}`,
    );
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "模型检查");
  }
}
