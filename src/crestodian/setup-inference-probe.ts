const SETUP_INFERENCE_TEST_MAX_TOKENS = 32;

/** Codex has no per-turn output-token override; its one-word probe needs no cap. */
export function resolveSetupInferenceProbeStreamParams(agentHarnessId?: string): {
  streamParams?: { maxTokens: number };
} {
  return agentHarnessId === "codex"
    ? {}
    : { streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS } };
}
