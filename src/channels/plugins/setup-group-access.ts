import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { WizardPrompter } from "../../wizard/prompts.js";

/**
 * Group access policy selected during channel setup.
 */
export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

/**
 * Prompts for the group access policy allowed by the channel setup flow.
 */
async function promptChannelAccessPolicy(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  allowOpen?: boolean;
  allowDisabled?: boolean;
}): Promise<ChannelAccessPolicy> {
  const options: Array<{ value: ChannelAccessPolicy; label: string }> = [
    { value: "allowlist", label: "Allowlist (recommended)" },
  ];
  if (params.allowOpen !== false) {
    options.push({ value: "open", label: "Open (allow all channels)" });
  }
  if (params.allowDisabled !== false) {
    options.push({ value: "disabled", label: "Disabled (block all channels)" });
  }
  const initialValue = params.currentPolicy ?? "allowlist";
  return await params.prompter.select({
    message: `${params.label} access`,
    options,
    initialValue,
  });
}

/**
 * Prompts for group allowlist entries and normalizes the response.
 */
async function promptChannelAllowlist(params: {
  prompter: WizardPrompter;
  label: string;
  currentEntries?: string[];
  placeholder?: string;
}): Promise<string[]> {
  const initialValue =
    params.currentEntries && params.currentEntries.length > 0
      ? normalizeStringEntries(params.currentEntries).join(", ")
      : undefined;
  const raw = await params.prompter.text({
    message: `${params.label} allowlist (comma-separated)`,
    placeholder: params.placeholder,
    initialValue,
  });
  return normalizeStringEntries(raw.split(/[\n,;]+/g));
}

/**
 * Prompts for the full group access config, including allowlist entries when needed.
 */
export async function promptChannelAccessConfig(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  currentEntries?: string[];
  placeholder?: string;
  allowOpen?: boolean;
  allowDisabled?: boolean;
  skipAllowlistEntries?: boolean;
  defaultPrompt?: boolean;
  updatePrompt?: boolean;
}): Promise<{ policy: ChannelAccessPolicy; entries: string[] } | null> {
  const hasEntries = (params.currentEntries ?? []).length > 0;
  const shouldPrompt = params.defaultPrompt ?? !hasEntries;
  const wants = await params.prompter.confirm({
    message: params.updatePrompt
      ? `Update ${params.label} access?`
      : `Configure ${params.label} access?`,
    initialValue: shouldPrompt,
  });
  if (!wants) {
    return null;
  }
  const policy = await promptChannelAccessPolicy(params);
  if (policy !== "allowlist" || params.skipAllowlistEntries) {
    // Open/disabled policies do not carry allowlist entries, so clear entries
    // at the prompt boundary before callers write config.
    return { policy, entries: [] };
  }
  const entries = await promptChannelAllowlist(params);
  return { policy, entries };
}
