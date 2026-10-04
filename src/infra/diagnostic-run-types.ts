export type DiagnosticRunScopeFields = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
};

export type DiagnosticAgentCommentaryFields = DiagnosticRunScopeFields & {
  type: "agent.commentary";
  harnessId: string;
  pluginId?: string;
  itemId?: string;
  sourceSequence: number;
  sourceTimestampMs: number;
  textLength: number;
  contentCaptured: boolean;
  contentTruncated: boolean;
};
