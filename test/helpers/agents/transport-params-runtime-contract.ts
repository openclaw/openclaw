export const OPENAI_GPT5_TRANSPORT_DEFAULTS = {
  parallel_tool_calls: true,
  text_verbosity: "low",
  openaiWsWarmup: false,
} as const;

export const OPENAI_GPT5_TRANSPORT_DEFAULT_CASES = [
  {
    provider: "openai",
    modelId: "gpt-5.4",
    api: "openai-responses",
  },
  {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    api: "openai-codex-responses",
  },
] as const;

export const NON_OPENAI_GPT5_TRANSPORT_CASE = {
  provider: "openrouter",
  modelId: "gpt-5.4",
  api: "openai-responses",
} as const;

export const GPT_PARALLEL_TOOL_CALLS_PAYLOAD_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
] as const;

export const UNRELATED_TOOL_CALLS_PAYLOAD_APIS = [
  "anthropic-messages",
  "google-generative-ai",
] as const;

export const CODEX_APP_SERVER_TRANSPORT_CONFIG = {
  appServer: {
    transport: "websocket",
    url: "wss://codex.example.test/app-server",
    authToken: "secret-token",
    headers: {
      "x-openclaw-contract": "transport",
    },
    requestTimeoutMs: 12_345,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "guardian_subagent",
    serviceTier: "flex",
  },
} as const;

export const CODEX_REASONING_EFFORT_CASES = [
  { thinkLevel: "minimal", effort: "minimal" },
  { thinkLevel: "low", effort: "low" },
  { thinkLevel: "medium", effort: "medium" },
  { thinkLevel: "high", effort: "high" },
  { thinkLevel: "xhigh", effort: "xhigh" },
  { thinkLevel: "off", effort: null },
] as const;
