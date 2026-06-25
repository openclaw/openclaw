// Environment flags passed from setup flows into relaunched TUI processes.
export const TUI_SETUP_AUTH_SOURCE_ENV = "OPENCLAW_TUI_SETUP_AUTH_SOURCE";
export const TUI_SETUP_AUTH_SOURCE_CONFIG = "config";
export const TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV = "OPENCLAW_TUI_SETUP_EXTRA_SYSTEM_PROMPT";

export function consumeTuiSetupExtraSystemPrompt(params: {
  local: boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (!params.local) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const prompt = env[TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV]?.trim() || undefined;
  delete env[TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV];
  return prompt;
}
