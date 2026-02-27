import type { BotConfig } from "../../../config/config.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { promptChannelAccessConfig, type ChannelAccessPolicy } from "./channel-access.js";

export async function configureChannelAccessWithAllowlist<TResolved>(params: {
  cfg: BotConfig;
  prompter: WizardPrompter;
  label: string;
  currentPolicy: ChannelAccessPolicy;
  currentEntries: string[];
  placeholder: string;
  updatePrompt: boolean;
  setPolicy: (cfg: BotConfig, policy: ChannelAccessPolicy) => BotConfig;
  resolveAllowlist: (params: { cfg: BotConfig; entries: string[] }) => Promise<TResolved>;
  applyAllowlist: (params: { cfg: BotConfig; resolved: TResolved }) => BotConfig;
}): Promise<BotConfig> {
  let next = params.cfg;
  const accessConfig = await promptChannelAccessConfig({
    prompter: params.prompter,
    label: params.label,
    currentPolicy: params.currentPolicy,
    currentEntries: params.currentEntries,
    placeholder: params.placeholder,
    updatePrompt: params.updatePrompt,
  });
  if (!accessConfig) {
    return next;
  }
  if (accessConfig.policy !== "allowlist") {
    return params.setPolicy(next, accessConfig.policy);
  }
  const resolved = await params.resolveAllowlist({
    cfg: next,
    entries: accessConfig.entries,
  });
  next = params.setPolicy(next, "allowlist");
  return params.applyAllowlist({
    cfg: next,
    resolved,
  });
}
