export const OPENAI_API_DEFAULT_MODEL_REF = "openai/gpt-6-astra";
export const ANTHROPIC_API_DEFAULT_MODEL_REF = "anthropic/claude-opus-5-5";
export const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-5-5";
export const CODEX_APP_SERVER_DEFAULT_MODEL_REF = "openai/gpt-6-astra";
export const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3.1-pro-preview";

export type InferenceBackendKind =
  | "existing-model"
  | "openai-api-key"
  | "anthropic-api-key"
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli";

export type InferenceBackendCandidate = {
  kind: InferenceBackendKind;
  modelRef: string;
  /** Short human label, e.g. "Claude Code CLI". */
  label: string;
  /** One-line provenance, e.g. "logged in", "ANTHROPIC_API_KEY set". */
  detail: string;
  /**
   * true: credentials verified; false: definitively logged out; undefined:
   * unknown (e.g. macOS keychain-backed logins we must not prompt for here).
   */
  credentials?: boolean;
};

export function detectAmbientInferenceBackends(
  env: NodeJS.ProcessEnv = process.env,
): InferenceBackendCandidate[] {
  const candidates: InferenceBackendCandidate[] = [];
  for (const [provider, label, modelRef] of [
    ["openai", "OpenAI", OPENAI_API_DEFAULT_MODEL_REF],
    ["anthropic", "Anthropic", ANTHROPIC_API_DEFAULT_MODEL_REF],
  ] as const) {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    if (!env[envVar]?.trim()) {
      continue;
    }
    candidates.push({
      kind: `${provider}-api-key`,
      modelRef,
      label: `${label} API key`,
      detail: `${envVar} set`,
      credentials: true,
    });
  }
  return candidates;
}
