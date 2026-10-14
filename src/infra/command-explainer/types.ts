/** Where a parsed command step appeared in the shell source. */
export type CommandContext =
  | "top-level"
  | "command-substitution"
  | "process-substitution"
  | "function-definition"
  | "wrapper-payload";

export type CommandShape =
  | "pipeline"
  | "and"
  | "or"
  | "sequence"
  | "if"
  | "for"
  | "while"
  | "case"
  | "subshell"
  | "group"
  | "background";

export type SourceSpan = {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};

export type CommandStep = {
  id?: string;
  parentCommandId?: string;
  context: CommandContext;
  executable: string;
  argv: string[];
  text: string;
  span: SourceSpan;
  executableSpan: SourceSpan;
  argvSpans?: SourceSpan[];
};

export type CommandOperatorKind =
  | "and"
  | "or"
  | "sequence"
  | "newline-sequence"
  | "pipe"
  | "stderr-pipe"
  | "background";

export type CommandOperator = {
  id: string;
  kind: CommandOperatorKind;
  text: string;
  span: SourceSpan;
  fromCommandId: string;
  toCommandId: string;
  parentCommandId?: string;
};

export type CommandRisk = { text: string; span: SourceSpan } & (
  | { kind: "inline-eval"; command: string; flag: string }
  | {
      kind: "shell-wrapper";
      executable: string;
      flag: string;
      payload: string;
    }
  | { kind: "shell-wrapper-through-carrier"; command: string }
  | { kind: "command-carrier"; command: string; flag?: string }
  | { kind: "command-substitution" }
  | { kind: "process-substitution" }
  | { kind: "dynamic-executable" }
  | {
      kind: "dynamic-argument";
      command: string;
      argumentIndex: number;
    }
  | { kind: "eval" }
  | { kind: "source"; command: string }
  | { kind: "alias" }
  | { kind: "function-definition"; name: string }
  | { kind: "line-continuation" }
  | { kind: "heredoc" }
  | { kind: "here-string" }
  | { kind: "redirect" }
  | { kind: "syntax-error" }
);

export type CommandExplanation = {
  ok: boolean;
  source: string;
  shapes: CommandShape[];
  topLevelCommands: CommandStep[];
  nestedCommands: CommandStep[];
  operators?: CommandOperator[];
  risks: CommandRisk[];
};
