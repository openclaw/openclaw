import type { ExecApprovalDecision } from "./exec-approvals.js";

export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

export function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(params?.allowedDecisions)) {
    for (const decision of params.allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

type ApprovalRiskLevel = "low" | "medium" | "high";

type CommandActionKind =
  | "database"
  | "delete"
  | "network"
  | "package"
  | "permissions"
  | "read"
  | "remote"
  | "service"
  | "source-control"
  | "unknown"
  | "write";

type CommandActionSummary = {
  text: string;
  risk: ApprovalRiskLevel;
  kind: CommandActionKind;
  reason?: string;
};

const RISK_RANK: Record<ApprovalRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const SECRETISH_PATH_RE =
  /(^|[/_.-])(secret|secrets|token|tokens|password|passwd|credential|credentials|api[-_]?key|private[-_]?key|id_rsa|\.env)([/_.-]|$)/i;
const SYSTEM_PATH_RE = /^(?:\/(?:bin|boot|dev|etc|lib|opt|proc|root|sbin|sys|usr)\b|\/var\/(?!log\b))/i;

function buildPlainEnglishApprovalLines(payload: PluginApprovalRequestPayload): string[] {
  const command = extractApprovalCommand(payload);
  if (command) {
    const summary = summarizeShellCommand(command);
    const lines = [`Summary: ${summary.headline}`, "What it wants to do:"];
    for (const action of summary.actions.slice(0, 5)) {
      lines.push(`- ${action}`);
    }
    if (summary.actions.length > 5) {
      lines.push(`- ...and ${summary.actions.length - 5} more step(s)`);
    }
    lines.push(`Risk: ${summary.risk}. ${summary.riskReason}`);
    return lines;
  }

  const tool = payload.toolName ? `the ${payload.toolName} tool` : "a protected plugin tool";
  const plugin = payload.pluginId ? ` from ${payload.pluginId}` : "";
  return [
    `Summary: let ${tool}${plugin} run one protected action`,
    `What it wants to do: ${firstLine(payload.description)}`,
    "Risk: medium. This is not a terminal command I can translate, so review the technical details before approving.",
  ];
}

function buildApprovalDecisionHelpLines(payload: PluginApprovalRequestPayload): string[] {
  const decisions = resolvePluginApprovalRequestAllowedDecisions(payload);
  const lines = ["Choices:"];
  if (decisions.includes("allow-once")) {
    lines.push("- allow-once: approve this one request");
  }
  if (decisions.includes("allow-always")) {
    lines.push("- allow-always: remember this kind of request for this agent");
  }
  if (decisions.includes("deny")) {
    lines.push("- deny: block it");
  }
  return lines;
}

function extractApprovalCommand(payload: PluginApprovalRequestPayload): string | null {
  const looksLikeCommandApproval =
    payload.toolName === "codex_command_approval" ||
    /command approval/i.test(payload.title) ||
    /^Command:\s*/m.test(payload.description);
  if (!looksLikeCommandApproval) {
    return null;
  }
  const match = /^Command:\s*(.+)$/m.exec(payload.description);
  return match?.[1]?.trim() || null;
}

function summarizeShellCommand(command: string): {
  headline: string;
  actions: string[];
  risk: ApprovalRiskLevel;
  riskReason: string;
} {
  const segments = splitCommandSegments(command);
  const summaries = segments.map((segment) => summarizeCommandSegment(segment)).filter(Boolean);
  const actions = summaries.map((summary) => summary.text);
  const risk = summaries.reduce<ApprovalRiskLevel>(
    (current, summary) => (RISK_RANK[summary.risk] > RISK_RANK[current] ? summary.risk : current),
    "low",
  );
  const highReason = summaries.find((summary) => summary.risk === "high" && summary.reason)?.reason;
  const mediumReason = summaries.find(
    (summary) => summary.risk === "medium" && summary.reason,
  )?.reason;
  const riskReason =
    highReason ??
    mediumReason ??
    (risk === "low"
      ? "This looks like a basic workspace check with no obvious network, service, or delete step."
      : "Review the technical details before approving.");

  return {
    headline: buildCommandHeadline(summaries),
    actions: actions.length > 0 ? actions : [`run terminal command: ${command}`],
    risk,
    riskReason,
  };
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function summarizeCommandSegment(segment: string): CommandActionSummary {
  if (/\|\s*(?:sudo\s+)?(?:bash|fish|sh|zsh)(?:\s|$)/.test(segment)) {
    return {
      text: "download or generate something and pipe it into a shell",
      risk: "high",
      kind: "network",
      reason: "Piping data into a shell can run code that is not visible in the approval prompt.",
    };
  }

  const resolved = resolveCommandWords(segment);
  const command = basename(resolved.words[0] ?? "");
  const args = resolved.words.slice(1);
  const nonOptionArgs = args.filter((word) => !word.startsWith("-"));
  const targetText = formatTargets(nonOptionArgs);
  const sensitiveTarget = nonOptionArgs.some(isSensitivePath);
  const systemTarget = nonOptionArgs.some(isSystemPath);
  const redirected = /(?:^|\s)(?:>>?|2>|&>)\s*\S+/.test(segment);
  const sudoPrefix = resolved.usedSudo
    ? {
        risk: "high" as const,
        reason: "It uses sudo, which can change protected parts of the machine.",
      }
    : null;

  switch (command) {
    case "cd":
      return withSudo(
        {
          text: `switch to folder${targetText}`,
          risk: systemTarget ? "medium" : "low",
          kind: "read",
          reason: systemTarget ? "It touches a system-level path." : undefined,
        },
        sudoPrefix,
      );
    case "pwd":
      return { text: "show the current folder", risk: "low", kind: "read" };
    case "ls":
      return withSudo(
        {
          text: `list files or folders${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It may reveal secret or credential file names."
            : systemTarget
              ? "It reads a system-level path."
              : undefined,
        },
        sudoPrefix,
      );
    case "find":
      return withSudo(
        {
          text: `search/list files${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It may search secret or credential paths."
            : systemTarget
              ? "It searches a system-level path."
              : undefined,
        },
        sudoPrefix,
      );
    case "rg":
    case "grep":
      return withSudo(
        {
          text: `search text/files${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It may read secret or credential paths."
            : systemTarget
              ? "It may read system-level files."
              : undefined,
        },
        sudoPrefix,
      );
    case "cat":
    case "head":
    case "less":
    case "sed":
    case "tail":
      return withSudo(
        {
          text: `read file contents${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It may print secrets or credentials."
            : systemTarget
              ? "It may read system-level files."
              : undefined,
        },
        sudoPrefix,
      );
    case "mkdir":
      return withSudo(
        {
          text: `create folder(s)${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "write",
          reason:
            sensitiveTarget || systemTarget
              ? "It creates folders in a sensitive or system path."
              : undefined,
        },
        sudoPrefix,
      );
    case "touch":
      return withSudo(
        {
          text: `create or update file timestamp${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "write",
          reason: sensitiveTarget || systemTarget ? "It writes to a sensitive or system path." : undefined,
        },
        sudoPrefix,
      );
    case "echo":
    case "printf":
      return withSudo(
        {
          text: redirected ? "write terminal output into a file" : "print text in the terminal",
          risk: redirected ? "medium" : "low",
          kind: redirected ? "write" : "read",
          reason: redirected ? "Shell redirection writes to a file." : undefined,
        },
        sudoPrefix,
      );
    case "cp":
    case "rsync":
      return withSudo(
        {
          text: `copy files or folders${targetText}`,
          risk: sensitiveTarget || systemTarget ? "high" : "medium",
          kind: "write",
          reason:
            sensitiveTarget || systemTarget
              ? "It copies data involving sensitive or system paths."
              : "Copying changes files on disk.",
        },
        sudoPrefix,
      );
    case "mv":
      return withSudo(
        {
          text: `move or rename files/folders${targetText}`,
          risk: sensitiveTarget || systemTarget ? "high" : "medium",
          kind: "write",
          reason:
            sensitiveTarget || systemTarget
              ? "It changes sensitive or system paths."
              : "Moving changes files on disk.",
        },
        sudoPrefix,
      );
    case "rm":
    case "rmdir":
      return withSudo(
        {
          text: `delete files or folders${targetText}`,
          risk: "high",
          kind: "delete",
          reason: "Delete commands can permanently remove data.",
        },
        sudoPrefix,
      );
    case "chmod":
    case "chown":
      return withSudo(
        {
          text: `change file permissions or ownership${targetText}`,
          risk: "high",
          kind: "permissions",
          reason: "Permission changes can expose or break protected files.",
        },
        sudoPrefix,
      );
    case "curl":
    case "wget":
      return withSudo(
        {
          text: `make a network request or download data${targetText}`,
          risk: "medium",
          kind: "network",
          reason: "Network commands can send or fetch data outside this machine.",
        },
        sudoPrefix,
      );
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return withSudo(summarizePackageManagerCommand(command, args), sudoPrefix);
    case "npx":
      return withSudo(
        {
          text: `run a package-provided command${targetText}`,
          risk: "high",
          kind: "package",
          reason: "npx can run code from project dependencies or the network.",
        },
        sudoPrefix,
      );
    case "git":
      return withSudo(summarizeGitCommand(args), sudoPrefix);
    case "docker":
    case "docker-compose":
      return withSudo(summarizeDockerCommand(command, args), sudoPrefix);
    case "systemctl":
    case "service":
    case "launchctl":
      return withSudo(summarizeServiceCommand(command, args), sudoPrefix);
    case "ssh":
    case "scp":
      return withSudo(
        {
          text: `connect to or copy data from another machine${targetText}`,
          risk: "medium",
          kind: "remote",
          reason: "Remote commands can read from or write to another host.",
        },
        sudoPrefix,
      );
    case "sqlite3":
    case "mysql":
    case "psql":
    case "prisma":
      return withSudo(summarizeDatabaseCommand(command, args, segment), sudoPrefix);
    case "bash":
    case "fish":
    case "node":
    case "python":
    case "python3":
    case "ruby":
    case "sh":
    case "zsh":
      return withSudo(
        {
          text: `run code or a script${targetText}`,
          risk: sensitiveTarget || systemTarget ? "high" : "medium",
          kind: "unknown",
          reason: "Scripts can do more than the command line shows directly.",
        },
        sudoPrefix,
      );
    default:
      return withSudo(
        {
          text: command ? `run terminal command: ${command}` : `run terminal command: ${segment}`,
          risk: "medium",
          kind: "unknown",
          reason: "This command is not recognized by the plain-English translator.",
        },
        sudoPrefix,
      );
  }
}

function summarizePackageManagerCommand(
  command: string,
  args: readonly string[],
): CommandActionSummary {
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (["install", "i", "add", "update", "upgrade"].includes(subcommand)) {
    return {
      text: `install or update project packages with ${command}`,
      risk: "high",
      kind: "package",
      reason: "Package installs can run dependency scripts and change project files.",
    };
  }
  if (["run", "exec", "dlx"].includes(subcommand)) {
    return {
      text: `run a project/package script with ${command}`,
      risk: "medium",
      kind: "package",
      reason: "Project scripts can run arbitrary code from the repo.",
    };
  }
  return {
    text: `use the ${command} package manager`,
    risk: "medium",
    kind: "package",
    reason: "Package manager commands can execute project tooling or change dependencies.",
  };
}

function summarizeGitCommand(args: readonly string[]): CommandActionSummary {
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (["diff", "log", "show", "status", "branch"].includes(subcommand)) {
    return { text: `inspect git state (${subcommand})`, risk: "low", kind: "source-control" };
  }
  if (["fetch", "pull", "checkout", "switch", "merge", "rebase", "stash"].includes(subcommand)) {
    return {
      text: `change or update git working state (${subcommand})`,
      risk: "medium",
      kind: "source-control",
      reason: "Git state changes can affect local files or branch history.",
    };
  }
  if (["clean", "push", "reset"].includes(subcommand)) {
    return {
      text: `run a higher-risk git operation (${subcommand})`,
      risk: "high",
      kind: "source-control",
      reason: "This git operation can discard local work or publish changes.",
    };
  }
  return {
    text: "run a git command",
    risk: "medium",
    kind: "source-control",
    reason: "Git commands can read or change source-control state.",
  };
}

function summarizeDockerCommand(command: string, args: readonly string[]): CommandActionSummary {
  const words = [command, ...args].filter(Boolean);
  const text = words.join(" ");
  if (/\b(?:logs|ps|inspect|images|compose\s+ls)\b/.test(text)) {
    return { text: `inspect Docker/container state (${text})`, risk: "low", kind: "service" };
  }
  if (/\b(?:down|kill|prune|rm|stop)\b/.test(text)) {
    return {
      text: `stop, remove, or clean Docker resources (${text})`,
      risk: "high",
      kind: "service",
      reason: "Docker stop/remove/cleanup commands can interrupt services or remove data.",
    };
  }
  return {
    text: `change Docker/container state (${text})`,
    risk: "medium",
    kind: "service",
    reason: "Docker commands can affect running services.",
  };
}

function summarizeServiceCommand(command: string, args: readonly string[]): CommandActionSummary {
  const text = [command, ...args].filter(Boolean).join(" ");
  if (/\b(?:cat|is-active|list-units|show|status)\b/.test(text)) {
    return { text: `inspect service status (${text})`, risk: "low", kind: "service" };
  }
  if (/\b(?:disable|enable|reload|restart|start|stop)\b/.test(text)) {
    return {
      text: `change a running service (${text})`,
      risk: "high",
      kind: "service",
      reason: "Service changes can restart, stop, or reconfigure background processes.",
    };
  }
  return {
    text: `run a service manager command (${text})`,
    risk: "medium",
    kind: "service",
    reason: "Service manager commands can affect background processes.",
  };
}

function summarizeDatabaseCommand(
  command: string,
  args: readonly string[],
  segment: string,
): CommandActionSummary {
  const text = [command, ...args].filter(Boolean).join(" ");
  if (/\b(?:delete|drop|insert|migrate|update|vacuum|write)\b/i.test(segment)) {
    return {
      text: `change database contents or schema (${text})`,
      risk: "high",
      kind: "database",
      reason: "Database write/schema commands can change app data.",
    };
  }
  return {
    text: `inspect or query a database (${text})`,
    risk: "medium",
    kind: "database",
    reason: "Database commands can reveal private app data.",
  };
}

function buildCommandHeadline(summaries: readonly CommandActionSummary[]): string {
  const kinds = new Set(summaries.map((summary) => summary.kind));
  const allLow = summaries.every((summary) => summary.risk === "low");
  if (kinds.has("delete")) {
    return "delete files or folders";
  }
  if (kinds.has("permissions")) {
    return "change file permissions";
  }
  if (kinds.has("service")) {
    return "inspect or change a running service";
  }
  if (kinds.has("network")) {
    return "use the network or download data";
  }
  if (kinds.has("package")) {
    return "run package/project tooling";
  }
  if (kinds.has("database")) {
    return "query or change a database";
  }
  if (kinds.has("source-control")) {
    return "inspect or change git state";
  }
  if (allLow && kinds.has("write")) {
    return "create/check workspace files or folders";
  }
  if (allLow && kinds.size === 1 && kinds.has("read")) {
    return "read or list files";
  }
  return "run a terminal command";
}

function resolveCommandWords(segment: string): { words: string[]; usedSudo: boolean } {
  const words = splitShellWords(segment);
  let usedSudo = false;
  while (words.length > 0) {
    const first = basename(words[0] ?? "");
    if (first === "sudo") {
      usedSudo = true;
      words.shift();
      continue;
    }
    if (first === "command") {
      words.shift();
      continue;
    }
    if (first === "env") {
      words.shift();
      while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0]?.startsWith("-"))) {
        words.shift();
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
      words.shift();
      continue;
    }
    break;
  }
  return { words, usedSudo };
}

function splitShellWords(input: string): string[] {
  const matches = input.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
  return matches.map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
}

function withSudo(
  summary: CommandActionSummary,
  sudoPrefix: { risk: "high"; reason: string } | null,
): CommandActionSummary {
  if (!sudoPrefix) {
    return summary;
  }
  return {
    ...summary,
    risk: RISK_RANK[sudoPrefix.risk] > RISK_RANK[summary.risk] ? sudoPrefix.risk : summary.risk,
    reason: sudoPrefix.reason,
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() || "run the requested plugin action";
}

function formatTargets(args: readonly string[]): string {
  const targets = args.filter((arg) => arg && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
  if (targets.length === 0) {
    return "";
  }
  const shown = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `: ${shown}, and ${targets.length - 3} more` : `: ${shown}`;
}

function basename(command: string): string {
  return command.split("/").pop()?.trim() ?? command;
}

function isSensitivePath(path: string): boolean {
  return SECRETISH_PATH_RE.test(path);
}

function isSystemPath(path: string): boolean {
  return SYSTEM_PATH_RE.test(path);
}

export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Approval needed`);
  lines.push(...buildPlainEnglishApprovalLines(request.request));
  lines.push(...buildApprovalDecisionHelpLines(request.request));
  lines.push("");
  lines.push("Technical details:");
  lines.push("Type: Plugin approval required");
  lines.push(`Title: ${request.request.title}`);
  lines.push(`Description: ${request.request.description}`);
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push(
    `Reply with: /approve <id> ${resolvePluginApprovalRequestAllowedDecisions(request.request).join(
      "|",
    )}`,
  );
  return lines.join("\n");
}

export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
