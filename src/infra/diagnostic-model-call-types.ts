export type DiagnosticModelCallPromptStats = Readonly<{
  inputMessagesCount?: number;
  inputMessagesChars?: number;
  systemPromptChars?: number;
  toolDefinitionsCount?: number;
  toolDefinitionsChars?: number;
  totalChars?: number;
}>;

export type DiagnosticModelCallUsage = Readonly<{
  usageReport?: { state: "available" | "unavailable" };
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  reasoningTokens?: number;
  promptTokens?: number;
  total?: number;
}>;

export type DiagnosticModelCallTerminalFields = {
  durationMs: number;
  providerProcessingMs?: number;
  providerWaitEstimateMs?: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  usage?: DiagnosticModelCallUsage;
  /** Provider-reported model from the terminal message; `model` stays the requested id, never synthesized. */
  responseModel?: string;
};
