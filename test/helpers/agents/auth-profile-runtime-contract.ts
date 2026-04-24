export const AUTH_PROFILE_RUNTIME_CONTRACT = {
  sessionId: "session-auth-contract",
  sessionKey: "agent:main:auth-contract",
  runId: "run-auth-contract",
  workspacePrompt: "continue with the bound Codex profile",
  openAiCodexProvider: "openai-codex",
  codexCliProvider: "codex-cli",
  codexHarnessProvider: "codex",
  claudeCliProvider: "claude-cli",
  openAiCodexProfileId: "openai-codex:work",
  anthropicProfileId: "anthropic:work",
} as const;

export function resolveContractAuthProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider
    ? AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider
    : normalized;
}

export function expectedForwardedAuthProfile(params: {
  provider: string;
  authProfileProvider: string;
  sessionAuthProfileId: string | undefined;
}): string | undefined {
  return resolveContractAuthProvider(params.provider) ===
    resolveContractAuthProvider(params.authProfileProvider)
    ? params.sessionAuthProfileId
    : undefined;
}
