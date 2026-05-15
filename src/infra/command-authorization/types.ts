export type CommandDialect = "argv" | "posix-shell" | "windows-cmd" | "powershell";

export type CommandAuthorizationInput =
  | {
      dialect: "argv";
      argv: readonly string[];
      command?: string;
    }
  | {
      dialect?: "posix-shell";
      command: string;
    }
  | {
      dialect: "windows-cmd" | "powershell";
      command: string;
    };

export type CommandAuthorizationContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
};

export type CommandAuthorizationRelationship =
  | "simple"
  | "pipeline"
  | "sequence"
  | "and-conditional"
  | "or-conditional"
  | "wrapper-inline";

export type CommandAuthorizationChainOperator = "&&" | "||" | ";";

export type CommandAuthorizationTree =
  | { kind: "unit"; unitId: string }
  | { kind: "pipeline"; children: CommandAuthorizationTree[] }
  | {
      kind: "chain";
      operators: CommandAuthorizationChainOperator[];
      children: CommandAuthorizationTree[];
    };

export type CommandPromptOnlyReason =
  | "command-substitution"
  | "dynamic-executable"
  | "interpreter-inline-eval"
  | "unsupported-cmd-wrapper"
  | "unsupported-powershell-wrapper"
  | "unsupported-shell-syntax";

export type CommandBlockReason = "policy-denied";

export type CommandUnanalyzableReason =
  | "empty-argv"
  | "empty-command"
  | "malformed-shell"
  | "unsupported-dialect";

export type CommandAuthorizationArgSpan = {
  startIndex: number;
  endIndex: number;
};

export type CommandAuthorizationUnit = {
  id: string;
  raw: string;
  argv: string[];
  argvSpans?: CommandAuthorizationArgSpan[];
  executable: string | null;
  normalizedExecutable: string | null;
  relationship: CommandAuthorizationRelationship;
  allowlistEligible: boolean;
  allowAlwaysEligible: boolean;
  promptOnlyReasons: CommandPromptOnlyReason[];
  blockReasons: CommandBlockReason[];
};

export type AnalyzableCommandAuthorizationPlan = {
  kind: "analyzable";
  source: string;
  dialect: CommandDialect;
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
};

export type PromptOnlyCommandAuthorizationPlan = {
  kind: "prompt-only";
  source: string;
  dialect: CommandDialect;
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
  promptOnlyReasons: CommandPromptOnlyReason[];
};

export type UnanalyzableCommandAuthorizationPlan = {
  kind: "unanalyzable";
  source: string;
  dialect: CommandDialect;
  reasons: CommandUnanalyzableReason[];
};

export type CommandAuthorizationPlan =
  | AnalyzableCommandAuthorizationPlan
  | PromptOnlyCommandAuthorizationPlan
  | UnanalyzableCommandAuthorizationPlan;
