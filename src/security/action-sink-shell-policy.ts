export type ShellRiskTag =
  | "safe_readonly"
  | "unknown_command"
  | "compound"
  | "redirection"
  | "heredoc"
  | "pipe_to_mutator"
  | "file_mutation"
  | "git_mutation"
  | "inline_script"
  | "shell_wrapper"
  | "privileged"
  | "find_exec"
  | "xargs"
  | "network_write";

export type ShellClassification = {
  command: string;
  riskTags: ShellRiskTag[];
  highRisk: boolean;
  mutating: boolean;
  reason: string;
};

const SAFE_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "sed",
  "awk",
  "git status",
  "git diff",
  "git log",
  "git show",
  "find",
]);
const MUTATOR_RE =
  /(^|\s)(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|tee|install|rsync|sed\s+-i|perl\s+-pi|python3?|node|ruby|perl|npm|pnpm|yarn|bun|make|git\s+(add|commit|push|reset|checkout|switch|merge|rebase|tag|clean|apply|am)|trash)(\s|$)/;
const NETWORK_RE =
  /(^|\s)(curl|wget|gh|linear|aws|gcloud|az|kubectl|vercel|netlify|flyctl|railway|docker|ssh|scp|rsync|zoho)(\s|$)/;
const INLINE_RE = /(^|\s)(node|python3?|ruby|perl)\s+(-e|--eval)\b/;
const SHELL_WRAPPER_RE = /(^|\s)(sh|bash|zsh|fish|cmd|powershell|pwsh)\s+(-c|\/c)\b/;

function add(tags: Set<ShellRiskTag>, tag: ShellRiskTag): void {
  tags.add(tag);
}

export function classifyShellCommand(input: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  elevated?: boolean;
}): ShellClassification {
  const command = input.command.trim();
  const tags = new Set<ShellRiskTag>();
  if (!command) add(tags, "unknown_command");
  if (input.elevated || /(^|\s)sudo\b/.test(command)) add(tags, "privileged");
  if (/[;&]|\|\||&&/.test(command)) add(tags, "compound");
  if (/<<[-~]?\w+/.test(command)) add(tags, "heredoc");
  if (/(^|[^<])>>?\s*[^&\s]/.test(command)) add(tags, "redirection");
  if (/\|\s*(tee|xargs|sh|bash|zsh|python|node|perl|ruby)\b/.test(command))
    add(tags, "pipe_to_mutator");
  if (/\bfind\b.*\s-exec\s/.test(command)) add(tags, "find_exec");
  if (/\bxargs\b/.test(command)) add(tags, "xargs");
  if (INLINE_RE.test(command)) add(tags, "inline_script");
  if (SHELL_WRAPPER_RE.test(command)) add(tags, "shell_wrapper");
  if (NETWORK_RE.test(command)) add(tags, "network_write");
  if (
    /\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|tag|clean|apply|am)\b/.test(
      command,
    )
  )
    add(tags, "git_mutation");
  if (MUTATOR_RE.test(command)) add(tags, "file_mutation");

  const first = command
    .split(/\s+/)
    .slice(0, command.startsWith("git ") ? 2 : 1)
    .join(" ");
  if (tags.size === 0 && !SAFE_COMMANDS.has(first)) add(tags, "unknown_command");
  if (tags.size === 0) add(tags, "safe_readonly");

  const riskTags = [...tags];
  const highRisk = riskTags.some((tag) => tag !== "safe_readonly");
  return {
    command,
    riskTags,
    highRisk,
    mutating: riskTags.some((tag) =>
      [
        "file_mutation",
        "git_mutation",
        "redirection",
        "heredoc",
        "pipe_to_mutator",
        "find_exec",
        "xargs",
      ].includes(tag),
    ),
    reason: highRisk
      ? `Shell command risk: ${riskTags.join(", ")}`
      : "Shell command appears read-only",
  };
}
