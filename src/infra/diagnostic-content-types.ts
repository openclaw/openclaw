export type DiagnosticModelCallContent = Readonly<{
  inputMessages?: unknown;
  outputMessages?: unknown;
  systemPrompt?: string;
  toolDefinitions?: unknown;
}>;

export type DiagnosticToolCallContent = Readonly<{
  toolInput?: unknown;
  toolOutput?: unknown;
}>;

export type DiagnosticSkillUsagePrivateData = Readonly<{
  skillFile: string;
}>;

export type DiagnosticEventPrivateData = Readonly<{
  /** Raw failure text for trusted diagnostics exporters; never part of the public event payload. */
  errorMessage?: string;
  modelContent?: DiagnosticModelCallContent;
  skillUsage?: DiagnosticSkillUsagePrivateData;
  toolContent?: DiagnosticToolCallContent;
}>;
