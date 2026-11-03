import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { WizardPrompter } from "../../wizard/prompts.js";

/**
 * Group access policy selected during channel setup.
 */
export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

/** Prompts for group access and, when needed, its allowlist entries. */
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
  const wants = await params.prompter.confirm({
    message: params.updatePrompt
      ? `Update ${params.label} access?`
      : `Configure ${params.label} access?`,
    initialValue: params.defaultPrompt ?? !hasEntries,
  });
  if (!wants) {
    return null;
  }
  const options: Array<{ value: ChannelAccessPolicy; label: string }> = [
    { value: "allowlist", label: "Allowlist (recommended)" },
  ];
  if (params.allowOpen !== false) {
    options.push({ value: "open", label: "Open (allow all channels)" });
  }
  if (params.allowDisabled !== false) {
    options.push({ value: "disabled", label: "Disabled (block all channels)" });
  }
  const policy = await params.prompter.select({
    message: `${params.label} access`,
    options,
    initialValue: params.currentPolicy ?? "allowlist",
  });
  if (policy !== "allowlist" || params.skipAllowlistEntries) {
    // Open/disabled policies do not carry allowlist entries, so clear entries
    // at the prompt boundary before callers write config.
    return { policy, entries: [] };
  }
  const initialValue =
    params.currentEntries && params.currentEntries.length > 0
      ? normalizeStringEntries(params.currentEntries).join(", ")
      : undefined;
  const raw = await params.prompter.text({
    message: `${params.label} allowlist (comma-separated)`,
    placeholder: params.placeholder,
    initialValue,
  });
  return { policy, entries: normalizeStringEntries(raw.split(/[\n,;]+/g)) };
}
