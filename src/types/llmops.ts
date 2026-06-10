export type LlmOpsProvider = "local" | "langfuse";

export type LlmOpsLangfuseSettings = {
  /** Public key for the Langfuse project environment. */
  publicKey: string;
  /** Secret API key injected securely via Vault at runtime. */
  secretKey: string;
  /** Self-hosted host endpoint endpoint. Defaults to Langfuse Cloud. */
  baseUrl?: string;
};

export type LlmOpsConfig = {
  /** Master LLMOps framework driver selection. Default: "local" */
  provider?: LlmOpsProvider;
  /** Core backend connection credentials. */
  langfuse?: LlmOpsLangfuseSettings;
  /** Central prompt management synchronization settings. */
  prompts?: {
    enabled?: boolean;
    cacheTtlMs?: number;
    failSoft?: boolean;
  };
  /** Deep execution trace logging tracking configuration. */
  tracing?: {
    enabled?: boolean;
    /** Optional sampling rate between 0.0 and 1.0. Default: 1.0 */
    sampleRate?: number;
  };
  /** Dynamic out-of-band automated evaluation or judge configurations. */
  evaluation?: {
    enabled?: boolean;
    /** Registered judge templates or evaluation metrics to fire automatically. */
    metrics?: string[];
  };
};
