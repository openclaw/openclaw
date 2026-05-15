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

export type PluginApprovalLanguage = "original" | "simple" | "simple-technical";

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
const SIMPLE_COMMAND_PREVIEW_MAX_LENGTH = 180;
const SHELL_OUTPUT_REDIRECTION_RE =
  /(?<![<>])(?:&>>?|\d*>>?)\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/g;
const SHELL_INPUT_REDIRECTION_RE =
  /(?<![<>])(?:\d*)<(?![<&])\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/g;
export const DEFAULT_PLUGIN_APPROVAL_LANGUAGE =
  "original" as const satisfies PluginApprovalLanguage;
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
  const explicit = normalizePluginApprovalAllowedDecisions(params?.allowedDecisions);
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

function normalizePluginApprovalAllowedDecisions(
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null,
): ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(allowedDecisions)) {
    for (const decision of allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit;
}

export function resolvePluginApprovalLanguage(value?: string | null): PluginApprovalLanguage {
  return value === "simple" || value === "simple-technical" || value === "original"
    ? value
    : DEFAULT_PLUGIN_APPROVAL_LANGUAGE;
}

type ApprovalRiskLevel = "low" | "medium" | "high";

type CommandActionKind =
  | "database"
  | "delete"
  | "format"
  | "network"
  | "package"
  | "permissions"
  | "process"
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
  hideWhenGrouped?: boolean;
  showCommandPreview?: boolean;
};

type ExpandedCommandSegment = {
  segment: string;
  fromPipeline?: boolean;
};

const RISK_RANK: Record<ApprovalRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const SECRETISH_PATH_RE =
  /(^|[/_.-])(secret|secrets|token|tokens|password|passwd|credential|credentials|api[-_]?key|private[-_]?key|id_rsa|netrc|\.env)([/_.-]|$)/i;
const SYSTEM_PATH_RE =
  /^(?:\/(?:bin|boot|dev|etc|lib|opt|proc|root|sbin|sys|usr)\b|\/var\/(?!log\b))/i;
const EMPTY_OPTION_VALUE_FLAGS = new Set<string>();
const GREP_OPTION_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--context",
  "--file",
  "--max-count",
  "--regexp",
]);
const HEAD_TAIL_OPTION_VALUE_FLAGS = new Set(["-c", "-n", "--bytes", "--lines"]);
const SED_OPTION_VALUE_FLAGS = new Set(["-e", "-f", "--expression", "--file"]);
const ENV_SEPARATE_VALUE_FLAGS = new Set(["-a", "-C", "-u", "--argv0", "--chdir", "--unset"]);
const ENV_INLINE_VALUE_FLAGS = new Set(["--argv0", "--chdir", "--unset"]);
const ENV_BOOLEAN_FLAGS = new Set([
  "-0",
  "-i",
  "-v",
  "--debug",
  "--ignore-environment",
  "--list-signal-handling",
  "--null",
  "--version",
]);
const ENV_UNSAFE_SPLIT_FLAGS = new Set(["-S", "--split-string"]);
const FIND_DELETE_PREDICATES = new Set(["-delete"]);
const FIND_EXEC_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_OUTPUT_FILE_PREDICATES = new Set(["-fls", "-fprint", "-fprint0", "-fprintf"]);
const CURL_UPLOAD_FILE_FLAGS = new Set(["-T", "--upload-file"]);
const CURL_UPLOAD_BODY_FLAGS = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "--json",
]);
const CURL_CONFIG_FLAGS = new Set(["-K", "--config"]);
const CURL_GET_FLAGS = new Set(["-G", "--get"]);
const CURL_NETRC_FILE_FLAGS = new Set(["--netrc-file"]);
const CURL_NETRC_FLAGS = new Set(["-n", "--netrc", "--netrc-optional"]);
const CURL_CREDENTIAL_FILE_FLAGS = new Set([
  "-E",
  "--cert",
  "--key",
  "--proxy-cert",
  "--proxy-key",
]);
const CURL_AUTH_VALUE_FLAGS = new Set([
  "-u",
  "-U",
  "--ftp-account",
  "--ftp-password",
  "--ftp-user",
  "--http-password",
  "--http-user",
  "--pass",
  "--oauth2-bearer",
  "--password",
  "--proxy-pass",
  "--proxy-password",
  "--proxy-tlspassword",
  "--proxy-tlsuser",
  "--proxy-user",
  "--tlspassword",
  "--tlsuser",
  "--user",
]);
const CURL_COOKIE_FLAGS = new Set(["-b", "--cookie"]);
const CURL_COOKIE_JAR_FLAGS = new Set(["-c", "--cookie-jar"]);
const CURL_HEADER_FLAGS = new Set(["-H", "--header", "--proxy-header"]);
const CURL_URL_FLAGS = new Set(["--url"]);
const CURL_URL_QUERY_FLAGS = new Set(["--url-query"]);
const CURL_OUTPUT_FLAGS = new Set([
  "-D",
  "-o",
  "--cookie-jar",
  "--dump-header",
  "--output",
  "--output-dir",
]);
const WGET_CONFIG_FLAGS = new Set(["--config"]);
const WGET_UPLOAD_FILE_FLAGS = new Set(["--body-file", "--post-file"]);
const WGET_UPLOAD_BODY_FLAGS = new Set(["--body-data", "--post-data"]);
const WGET_AUTH_VALUE_FLAGS = new Set([
  "--ftp-password",
  "--ftp-user",
  "--http-password",
  "--http-user",
  "--password",
  "--proxy-password",
  "--proxy-user",
  "--user",
]);
const WGET_CREDENTIAL_FILE_FLAGS = new Set(["--certificate", "--private-key"]);
const WGET_COOKIE_FLAGS = new Set(["--load-cookies"]);
const WGET_COOKIE_JAR_FLAGS = new Set(["--save-cookies"]);
const WGET_HEADER_FLAGS = new Set(["--header"]);
const WGET_OUTPUT_FLAGS = new Set([
  "-O",
  "-P",
  "-a",
  "-o",
  "--append-output",
  "--directory-prefix",
  "--output-document",
  "--output-file",
]);

function buildPlainEnglishApprovalLines(payload: PluginApprovalRequestPayload): string[] {
  const command = extractApprovalCommand(payload);
  if (command) {
    const summary = summarizeShellCommand(command);
    const lines = ["Action", formatSentence(summary.headline), "", "It will"];
    for (const action of summary.actions.slice(0, 4)) {
      lines.push(`- ${action}`);
    }
    if (summary.actions.length > 4) {
      lines.push(`- ${summary.actions.length - 4} more background step(s)`);
    }
    if (summary.commandPreview) {
      lines.push("", "Command preview", summary.commandPreview);
    }
    lines.push("", `Risk: ${formatRiskLevel(summary.risk)}`, summary.riskReason);
    return lines;
  }

  const tool = payload.toolName ? `the ${payload.toolName} tool` : "a protected plugin tool";
  const plugin = payload.pluginId ? ` from ${payload.pluginId}` : "";
  return [
    "Action",
    `Let ${tool}${plugin} run one protected action`,
    "",
    "It will",
    `- ${firstLine(payload.description)}`,
    "",
    "Risk: Medium",
    "I cannot fully summarize this request, so review it before approving.",
  ];
}

function buildApprovalDecisionHelpLines(
  request: PluginApprovalRequest,
  options?: {
    includeManualFallback?: boolean;
    allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
  },
): string[] {
  const decisions =
    options?.allowedDecisions != null
      ? normalizePluginApprovalAllowedDecisions(options.allowedDecisions)
      : resolvePluginApprovalRequestAllowedDecisions(request.request);
  if (decisions.length === 0) {
    return [];
  }
  const lines = ["", "Choose below."];
  if (options?.includeManualFallback) {
    lines.push(`If buttons are unavailable, reply: /approve ${request.id} ${decisions.join("|")}`);
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
  const lines = payload.description.split(/\r?\n/);
  const commandStartIndex = lines.findIndex((line) => /^Command:\s*/.test(line));
  if (commandStartIndex < 0) {
    return null;
  }
  const commandLines = [lines[commandStartIndex]?.replace(/^Command:\s*/, "") ?? ""];
  for (const line of lines.slice(commandStartIndex + 1)) {
    if (isCommandApprovalMetadataLine(line)) {
      break;
    }
    commandLines.push(line);
  }
  return commandLines.join("\n").trim() || null;
}

function isCommandApprovalMetadataLine(line: string): boolean {
  return /^(?:Proposed exec policy|Session|Tool|Plugin|Agent|ID|Expires in|Reply with|Title|Description):\s*/i.test(
    line.trim(),
  );
}

function decodeBasicHtmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const normalized = entity.toLowerCase();
    switch (normalized) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default: {
        const decimal = /^&#(\d+);$/i.exec(entity);
        const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
        const codePoint = decimal
          ? Number.parseInt(decimal[1] ?? "", 10)
          : hex
            ? Number.parseInt(hex[1] ?? "", 16)
            : Number.NaN;
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
    }
  });
}

function summarizeShellCommand(command: string): {
  headline: string;
  actions: string[];
  risk: ApprovalRiskLevel;
  riskReason: string;
  commandPreview?: string;
} {
  const decodedCommand = decodeBasicHtmlEntities(command);
  const expandedSegments = splitCommandSegments(decodedCommand).flatMap((segment) =>
    expandCommandSegment(segment),
  );
  const summaries = expandedSegments.map((segment) => summarizeExpandedCommandSegment(segment));
  const visibleSummaries = summaries.filter((summary) => !summary.hideWhenGrouped);
  const actionSummaries = visibleSummaries.length > 0 ? visibleSummaries : summaries;
  const actions = uniqueStrings(actionSummaries.map((summary) => summary.text));
  const risk = summaries.reduce<ApprovalRiskLevel>(
    (current, summary) => (RISK_RANK[summary.risk] > RISK_RANK[current] ? summary.risk : current),
    "low",
  );
  const highReason = summaries.find((summary) => summary.risk === "high" && summary.reason)?.reason;
  const mediumReason = summaries.find(
    (summary) => summary.risk === "medium" && summary.reason,
  )?.reason;
  const riskReason = highReason ?? mediumReason ?? buildDefaultRiskReason(risk, summaries);

  return {
    headline: buildCommandHeadline(actionSummaries),
    actions: actions.length > 0 ? actions : ["run the requested terminal command"],
    risk,
    riskReason,
    commandPreview: shouldShowCommandPreview(summaries)
      ? buildCommandPreview(decodedCommand)
      : undefined,
  };
}

function shouldShowCommandPreview(summaries: readonly CommandActionSummary[]): boolean {
  return summaries.some((summary) => summary.kind === "unknown" || summary.showCommandPreview);
}

function buildCommandPreview(command: string): string {
  const compact = redactSensitiveCommandText(command).replace(/\s+/g, " ").trim();
  if (compact.length <= SIMPLE_COMMAND_PREVIEW_MAX_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, SIMPLE_COMMAND_PREVIEW_MAX_LENGTH - 1).trimEnd()}...`;
}

function redactQuotedCookieHeaderValues(command: string): string {
  return command.replace(
    /(["'])([^"']*\b(?:set-)?cookie:\s*)[^"']*\1/gi,
    (_match: string, quote: string, prefix: string) => `${quote}${prefix}[redacted]${quote}`,
  );
}

function redactCurlQueryLikeCommandValues(command: string): string {
  return command
    .replace(
      /(--(?:url-query|data|data-ascii|data-binary|data-raw|data-urlencode|form|form-string|json|body-data|post-data)|-[dF])(=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"\\]+))/gi,
      (
        _match: string,
        flag: string,
        separator: string,
        doubleQuoted: string,
        singleQuoted: string,
        bare: string,
      ) => {
        const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
        const redacted = redactSensitiveCurlBodyValue(value);
        if (doubleQuoted !== undefined) {
          return `${flag}${separator}"${redacted}"`;
        }
        if (singleQuoted !== undefined) {
          return `${flag}${separator}'${redacted}'`;
        }
        return `${flag}${separator}${redacted}`;
      },
    )
    .replace(
      /(^|\s)(-[dF])((?:\+)?[^\s'"\\]+)/g,
      (match: string, leading: string, flag: string, value: string) => {
        const redacted = redactSensitiveCurlBodyValue(value);
        return redacted === value ? match : `${leading}${flag}${redacted}`;
      },
    );
}

function redactSensitiveCurlBodyValue(value: string): string {
  return redactSensitiveJsonLikeCredentialValues(redactSensitiveCurlUrlQueryValue(value));
}

function redactSensitiveCurlUrlQueryValue(value: string): string {
  return value.replace(/(^|[?&=])([^=\s&#]+)=([^&\s#]*)/gi, (match, prefix, key) =>
    isSensitiveUrlQueryKey(String(key)) ? `${prefix}${key}=[redacted]` : match,
  );
}

function redactSensitiveJsonLikeCredentialValues(value: string): string {
  return value.replace(
    /(["']?)([A-Za-z0-9_.-]+)\1(\s*:\s*)("[^"]*"|'[^']*'|[^,}\s]+)/gi,
    (match: string, quote: string, key: string, separator: string, rawValue: string) => {
      if (!isSensitiveUrlQueryKey(key)) {
        return match;
      }
      const redactedValue = rawValue.startsWith('"')
        ? '"[redacted]"'
        : rawValue.startsWith("'")
          ? "'[redacted]'"
          : "[redacted]";
      return `${quote}${key}${quote}${separator}${redactedValue}`;
    },
  );
}

function redactSensitiveCommandText(command: string): string {
  return redactCurlQueryLikeCommandValues(
    redactSensitiveUrlQueryValues(redactQuotedCookieHeaderValues(command)),
  )
    .replace(
      /(authorization:\s*(?:(?:bearer|basic|token)\s+)?)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1[redacted]",
    )
    .replace(/((?:set-)?cookie:\s*)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1[redacted]")
    .replace(
      /((?:x[-_])?(?:api[-_]?key|auth[-_]?token|access[-_]?token|private[-_]?token|password|passwd|secret|token)\s*:\s*)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_.-]*(?:api[-_]?key|auth[-_]?token|access[-_]?token|private[-_]?token|password|passwd|secret|token)[A-Za-z0-9_.-]*\s*=\s*)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(--(?:api[-_]?key|auth[-_]?token|oauth2[-_]?bearer|password|passwd|secret|token|pass|proxy-pass|tlsuser|tlspassword|proxy-tlsuser|proxy-tlspassword)(?:=|\s+))(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(--(?:cert|key|proxy-cert|proxy-key|certificate|private-key)(?:=|\s+))(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1[redacted]",
    )
    .replace(/(^|\s)(-E)(\s+|=)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/g, "$1$2$3[redacted]")
    .replace(/(^|\s)(-E)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/g, "$1$2[redacted]")
    .replace(/(^|\s)(-u|-U)(\s+|=)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1$2$3[redacted]")
    .replace(/(^|\s)(-u|-U)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1$2[redacted]")
    .replace(/(^|\s)(-b)(\s+|=)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1$2$3[redacted]")
    .replace(/(^|\s)(-b)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1$2[redacted]")
    .replace(
      /(^|\s)(--(?:user|proxy-user|http-user|http-password|ftp-user|ftp-password|password|proxy-password|ftp-account))(=|\s+)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi,
      "$1$2$3[redacted]",
    )
    .replace(/(^|\s)(--cookie)(=|\s+)(?:"[^"]+"|'[^']+'|[^\s'"\\]+)/gi, "$1$2$3[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
}

function redactSensitiveUrlQueryValues(command: string): string {
  return command.replace(/([?&])([^=\s&#]+)=([^&\s'"#]+)/gi, (match, separator, key) => {
    return isSensitiveUrlQueryKey(String(key)) ? `${separator}${key}=[redacted]` : match;
  });
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = () => {
    const segment = current.trim();
    if (segment) {
      segments.push(segment);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (quote) {
      current += char;
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = null;
      }
      escaped = false;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushCurrent();
      index += 1;
      continue;
    }
    if (char === "&" && !isShellRedirectionAmpersand(command, index)) {
      pushCurrent();
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushCurrent();
      continue;
    }
    current += char;
  }
  pushCurrent();
  return segments;
}

function isShellRedirectionAmpersand(command: string, index: number): boolean {
  const previous = command[index - 1] ?? "";
  const next = command[index + 1] ?? "";
  return previous === "|" || previous === ">" || previous === "<" || next === ">";
}

function expandCommandSegment(segment: string): ExpandedCommandSegment[] {
  const controlSegments = expandShellControlSegment(segment);
  if (controlSegments) {
    return controlSegments.flatMap((controlSegment) => expandCommandSegment(controlSegment));
  }
  if (isShellBookkeepingSegment(segment)) {
    return [];
  }
  const resolved = resolveCommandWords(segment);
  const nested = extractShellWrapperCommand(resolved.words);
  if (nested) {
    return splitCommandSegments(nested).flatMap((innerSegment) =>
      expandCommandSegment(innerSegment),
    );
  }
  if (hasShellExecutionExpansion(segment)) {
    return [{ segment }];
  }
  if (isPipeToShellSegment(segment)) {
    return [{ segment }];
  }
  const pipelineStages = splitPipelineStages(segment);
  if (pipelineStages.length > 1) {
    return pipelineStages.flatMap((pipelineStage) => {
      const expandedStages = expandCommandSegment(pipelineStage);
      for (const expanded of expandedStages) {
        expanded.fromPipeline = true;
      }
      return expandedStages;
    });
  }
  return [{ segment }];
}

function expandShellControlSegment(segment: string): string[] | null {
  const trimmed = segment.trim();
  if (/^(?:then|else|fi|do|done)\b$/.test(trimmed)) {
    return [];
  }

  const leadingBody = /^(?:then|else|do)\s+(.+)$/s.exec(trimmed);
  if (leadingBody) {
    return splitCommandSegments(leadingBody[1] ?? "");
  }

  const conditional = /^(?:if|elif|while|until)\s+(.+)$/s.exec(trimmed);
  if (conditional) {
    const condition = stripTrailingShellControl(conditional[1] ?? "");
    return condition ? splitCommandSegments(condition) : [];
  }

  return null;
}

function stripTrailingShellControl(value: string): string {
  return value.replace(/\s+(?:then|do)\b[\s\S]*$/i, "").trim();
}

function isShellBookkeepingSegment(segment: string): boolean {
  return /^set\s+[+-][A-Za-z]+\b/.test(segment.trim());
}

function splitPipelineStages(segment: string): string[] {
  const stages: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = () => {
    const stage = current.trim();
    if (stage) {
      stages.push(stage);
    }
    current = "";
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    const next = segment[index + 1] ?? "";
    if (quote) {
      current += char;
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = null;
      }
      escaped = false;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "|" && next !== "|") {
      pushCurrent();
      if (next === "&") {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  pushCurrent();
  return stages;
}

function isPipeToShellSegment(segment: string): boolean {
  return /\|&?\s*(?:sudo\s+)?(?:bash|fish|sh|zsh)(?:\s|$)/.test(segment);
}

function extractShellWrapperCommand(words: readonly string[]): string | null {
  const command = cleanCommandName(basename(words[0] ?? ""));
  if (!["bash", "fish", "sh", "zsh"].includes(command)) {
    return null;
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-c" || word === "-lc" || /^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      return words[index + 1]?.trim() || null;
    }
  }
  return null;
}

function summarizeExpandedCommandSegment(expanded: ExpandedCommandSegment): CommandActionSummary {
  const summary = summarizeCommandSegment(expanded.segment);
  if (expanded.fromPipeline && summary.kind === "unknown") {
    return {
      ...summary,
      risk: "high",
      reason:
        "This command is part of a pipeline I cannot fully summarize, so review it before approving.",
    };
  }
  return summary;
}

function summarizeCommandSegment(segment: string): CommandActionSummary {
  if (isPipeToShellSegment(segment)) {
    return {
      text: "download or generate something and pipe it into a shell",
      risk: "high",
      kind: "network",
      reason: "Piping data into a shell can run code that is not visible in the approval prompt.",
    };
  }

  const resolved = resolveCommandWords(segment);
  const sudoPrefix = resolved.usedSudo
    ? {
        risk: "high" as const,
        reason: "It uses sudo, which can change protected parts of the machine.",
      }
    : null;
  if (resolved.wrapperParseFailed) {
    return withSudo(
      {
        text: "run command through an environment wrapper",
        risk: "high",
        kind: "unknown",
        reason:
          "This command uses env options I cannot fully summarize, so review it before approving.",
      },
      sudoPrefix,
    );
  }
  const command = cleanCommandName(basename(resolved.words[0] ?? ""));
  const args = resolved.words.slice(1);
  const nonOptionArgs = getCommandTargetArgs(command, args);
  const targetText = formatTargets(nonOptionArgs);
  const sensitiveTarget = nonOptionArgs.some(isSensitivePath);
  const systemTarget = nonOptionArgs.some(isSystemPath);
  const redirectionTargets = getShellOutputRedirectionTargets(segment);
  const redirected = redirectionTargets.length > 0;

  if (hasShellExecutionExpansion(segment)) {
    return withSudo(
      {
        text: "run shell expansion or nested command",
        risk: "high",
        kind: "unknown",
        reason:
          "Shell expansions can run nested commands that are not fully visible in the approval summary.",
      },
      sudoPrefix,
    );
  }

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
    case "[":
    case "test":
      return withSudo(
        {
          text: `check whether a condition or file exists${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It checks a secret or credential path."
            : systemTarget
              ? "It checks a system-level path."
              : undefined,
        },
        sudoPrefix,
      );
    case ".":
    case "source":
      return withSudo(
        {
          text: `run commands from a sourced file${targetText}`,
          risk: "high",
          kind: "unknown",
          reason: "Sourcing a file runs its shell code in the current process.",
          showCommandPreview: true,
        },
        sudoPrefix,
      );
    case "pwd":
      return { text: "show the current folder", risk: "low", kind: "read" };
    case "sleep":
      return {
        text: "wait briefly",
        risk: "low",
        kind: "read",
        hideWhenGrouped: true,
      };
    case "printf":
    case "echo":
      if (redirected) {
        return summarizeRedirectedWrite(redirectionTargets, sudoPrefix);
      }
      return withSudo(
        {
          text: "format a short status message",
          risk: "low",
          kind: "format",
          hideWhenGrouped: !redirected,
        },
        sudoPrefix,
      );
    case "ps":
    case "pgrep":
      return withSudo(
        {
          text: "check running processes",
          risk: "low",
          kind: "process",
        },
        sudoPrefix,
      );
    case "kill":
    case "killall":
    case "pkill":
      return withSudo(
        {
          text: "stop running processes",
          risk: "high",
          kind: "process",
          reason: "Stopping processes can interrupt running work or services.",
        },
        sudoPrefix,
      );
    case "ls":
      if (redirected) {
        return summarizeRedirectedWrite(redirectionTargets, sudoPrefix);
      }
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
    case "find": {
      const findRoots = getFindSearchRoots(args);
      const findTargetText = formatTargets(findRoots.length > 0 ? findRoots : nonOptionArgs);
      if (hasFindDeletePredicate(args)) {
        return withSudo(
          {
            text: `delete files found by search${findTargetText}`,
            risk: "high",
            kind: "delete",
            reason: "find -delete can permanently remove every matching file.",
            showCommandPreview: true,
          },
          sudoPrefix,
        );
      }
      if (hasFindExecPredicate(args)) {
        return withSudo(
          {
            text: `run commands for each file found${findTargetText}`,
            risk: "high",
            kind: "unknown",
            reason:
              "find -exec can run another command on every matched file, so review it before approving.",
            showCommandPreview: true,
          },
          sudoPrefix,
        );
      }
      const findOutputFileTargets = getFindOutputFileTargets(args);
      if (findOutputFileTargets.targets.length > 0 || findOutputFileTargets.ambiguous) {
        return withSudo(
          {
            text: `write find output to files${formatTargets(findOutputFileTargets.targets)}`,
            risk: "high",
            kind: "write",
            reason: "find output-file predicates can create or overwrite files.",
            showCommandPreview: true,
          },
          sudoPrefix,
        );
      }
      if (redirected) {
        return summarizeRedirectedWrite(redirectionTargets, sudoPrefix);
      }
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
    }
    case "rg":
    case "grep":
      if (redirected) {
        return summarizeRedirectedWrite(redirectionTargets, sudoPrefix);
      }
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
      if (redirected) {
        return summarizeRedirectedWrite(redirectionTargets, sudoPrefix);
      }
      if (command === "sed" && hasSedInPlaceOption(args)) {
        const sedTargets = getSedInPlaceTargets(args);
        const sedTargetText = formatTargets(sedTargets.length > 0 ? sedTargets : nonOptionArgs);
        const sedSensitiveTarget = sedTargets.some(isSensitivePath);
        const sedSystemTarget = sedTargets.some(isSystemPath);
        return withSudo(
          {
            text: `edit files in place${sedTargetText}`,
            risk: sedSensitiveTarget || sedSystemTarget ? "high" : "medium",
            kind: "write",
            reason: "sed -i can overwrite files in place.",
            showCommandPreview: true,
          },
          sudoPrefix,
        );
      }
      return withSudo(
        {
          text: formatReadFileAction(command, nonOptionArgs),
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
    case "wc":
    case "stat":
    case "file":
      return withSudo(
        {
          text: `inspect file details${targetText}`,
          risk: sensitiveTarget || systemTarget ? "medium" : "low",
          kind: "read",
          reason: sensitiveTarget
            ? "It may inspect secret or credential files."
            : systemTarget
              ? "It inspects system-level files."
              : undefined,
        },
        sudoPrefix,
      );
    case "df":
    case "du":
      return withSudo(
        {
          text: `check disk usage${targetText}`,
          risk: systemTarget ? "medium" : "low",
          kind: "read",
          reason: systemTarget ? "It inspects system-level storage paths." : undefined,
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
          reason:
            sensitiveTarget || systemTarget
              ? "It writes to a sensitive or system path."
              : undefined,
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
      return withSudo(summarizeNetworkCommand(command, args, segment), sudoPrefix);
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
    case "journalctl":
      return withSudo(
        {
          text: "read service logs",
          risk: "low",
          kind: "service",
        },
        sudoPrefix,
      );
    case "ss":
    case "lsof":
    case "netstat":
      return withSudo(
        {
          text: "check network listeners or open files",
          risk: "low",
          kind: "process",
        },
        sudoPrefix,
      );
    case "ssh":
      return withSudo(summarizeRemoteCommand(args, targetText), sudoPrefix);
    case "scp":
      return withSudo(
        {
          text: `copy data to or from another machine${targetText}`,
          risk: sensitiveTarget || systemTarget ? "high" : "medium",
          kind: "remote",
          reason:
            sensitiveTarget || systemTarget
              ? "Remote copy commands can transfer sensitive or system files."
              : "Remote copy commands can read from or write to another host.",
          showCommandPreview: sensitiveTarget || systemTarget,
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
          risk: "high",
          kind: "unknown",
          reason: "Interpreter commands can run arbitrary code or scripts.",
          showCommandPreview: true,
        },
        sudoPrefix,
      );
    case "jq":
      return withSudo(
        {
          text: redirected ? "filter data and write the result" : "filter command output",
          risk: redirected ? "medium" : "low",
          kind: redirected ? "write" : "format",
          reason: redirected ? "Shell redirection writes to a file." : undefined,
          hideWhenGrouped: !redirected,
        },
        sudoPrefix,
      );
    case "awk":
    case "cut":
    case "sort":
    case "tr":
    case "uniq":
      return withSudo(
        {
          text: redirected ? "process text and write the result" : "process text output",
          risk: redirected ? "medium" : "low",
          kind: redirected ? "write" : "format",
          reason: redirected ? "Shell redirection writes to a file." : undefined,
          hideWhenGrouped: !redirected,
        },
        sudoPrefix,
      );
    default:
      return withSudo(
        {
          text: command ? `run ${command}` : "run the requested terminal command",
          risk: "medium",
          kind: "unknown",
          reason: "I cannot fully summarize this command, so review it before approving.",
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

const GIT_GLOBAL_FLAGS = new Set([
  "--bare",
  "--glob-pathspecs",
  "--help",
  "--html-path",
  "--icase-pathspecs",
  "--info-path",
  "--literal-pathspecs",
  "--man-path",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
  "--paginate",
  "--version",
  "-h",
  "-p",
  "-v",
]);

const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
  "-C",
  "-c",
]);

function parseGitSubcommand(args: readonly string[]): {
  ambiguous: boolean;
  remainingArgs: string[];
  subcommand: string;
} {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return { ambiguous: false, remainingArgs: args.slice(index + 1), subcommand: "" };
    }
    if (!arg.startsWith("-")) {
      return { ambiguous: false, remainingArgs: args.slice(index + 1), subcommand: arg };
    }

    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (GIT_GLOBAL_FLAGS.has(arg) || GIT_GLOBAL_FLAGS.has(optionName)) {
      continue;
    }
    if ((arg.startsWith("-C") && arg.length > 2) || (arg.startsWith("-c") && arg.length > 2)) {
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(optionName)) {
      if (!arg.includes("=")) {
        index += 1;
        if (index >= args.length) {
          return { ambiguous: true, remainingArgs: [], subcommand: "" };
        }
      }
      continue;
    }

    return { ambiguous: true, remainingArgs: [], subcommand: "" };
  }
  return { ambiguous: false, remainingArgs: [], subcommand: "" };
}

function hasGitDiscardOption(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-f" ||
      arg === "--force" ||
      arg === "--discard-changes" ||
      arg === "--merge" ||
      arg === "--ours" ||
      arg === "--theirs",
  );
}

function isGitPathCheckoutDiscard(args: readonly string[]): boolean {
  const createsBranch = args.some((arg) => arg === "-b" || arg === "-B" || arg === "--orphan");
  return (
    args.includes("--") ||
    args.some(
      (arg) => arg === "." || arg === ":/" || arg.startsWith("./") || arg.startsWith("../"),
    ) ||
    args.some((arg) => arg === "--pathspec-from-file" || arg.startsWith("--pathspec-from-file=")) ||
    (!createsBranch && args.some((arg) => arg !== "--" && !arg.startsWith("-")))
  );
}

function summarizeGitCommand(args: readonly string[]): CommandActionSummary {
  const { ambiguous, remainingArgs, subcommand } = parseGitSubcommand(args);
  if (ambiguous) {
    return {
      text: "run a git command with global options",
      risk: "high",
      kind: "source-control",
      reason:
        "I cannot confidently identify the git subcommand after its global options, so review it before approving.",
      showCommandPreview: true,
    };
  }
  if (["diff", "log", "show", "status", "branch"].includes(subcommand)) {
    return { text: `inspect git state (${subcommand})`, risk: "low", kind: "source-control" };
  }
  if (
    ["fetch", "pull", "checkout", "switch", "merge", "rebase", "stash", "restore"].includes(
      subcommand,
    )
  ) {
    if (
      subcommand === "restore" ||
      ((subcommand === "checkout" || subcommand === "switch") &&
        (hasGitDiscardOption(remainingArgs) || isGitPathCheckoutDiscard(remainingArgs)))
    ) {
      return {
        text: `run a higher-risk git operation (${subcommand})`,
        risk: "high",
        kind: "source-control",
        reason: "This git operation can discard local work or overwrite working-tree files.",
        showCommandPreview: true,
      };
    }
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

function summarizeRemoteCommand(args: readonly string[], targetText: string): CommandActionSummary {
  const remoteCommand = hasRemoteShellCommand(args);
  return {
    text: remoteCommand
      ? `connect to another machine and run a remote command${targetText}`
      : `connect to another machine${targetText}`,
    risk: remoteCommand ? "high" : "medium",
    kind: "remote",
    reason: remoteCommand
      ? "SSH can run commands on another host, including destructive commands."
      : "Remote commands can read from or write to another host.",
    showCommandPreview: remoteCommand,
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
  const actionText = summaries.map((summary) => summary.text).join(" ");
  if (actionText.includes("agent-route log") && kinds.has("process")) {
    return "check agent route status";
  }
  if (kinds.has("delete")) {
    return "delete files or folders";
  }
  if (kinds.has("permissions")) {
    return "change file permissions";
  }
  if (kinds.has("service")) {
    return "inspect or change a running service";
  }
  if (kinds.has("process")) {
    return "check running processes";
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
  if (allLow && kinds.size === 1 && kinds.has("format")) {
    return "format a status message";
  }
  return "run a terminal command";
}

function resolveCommandWords(segment: string): {
  words: string[];
  usedSudo: boolean;
  wrapperParseFailed?: boolean;
} {
  const words = splitShellWords(segment);
  let usedSudo = false;
  while (words.length > 0) {
    const first = cleanCommandName(basename(words[0] ?? ""));
    if (first === "sudo") {
      usedSudo = true;
      words.shift();
      continue;
    }
    if (first === "command") {
      words.shift();
      continue;
    }
    if (first === "!") {
      words.shift();
      continue;
    }
    if (first === "env") {
      const stripped = stripEnvWrapperWords(words);
      if (!stripped) {
        return { words, usedSudo, wrapperParseFailed: true };
      }
      words.splice(0, words.length, ...stripped);
      continue;
    }
    if (first === "timeout" || first === "gtimeout") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-k", "--kill-after", "-s", "--signal"].includes(option ?? "") && words[0]) {
          words.shift();
        }
      }
      if (words[0] && /^\d+(?:\.\d+)?[smhd]?$/i.test(words[0])) {
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

function stripEnvWrapperWords(words: readonly string[]): string[] | null {
  const rest = words.slice(1);
  while (rest.length > 0) {
    const arg = rest[0] ?? "";
    if (!arg) {
      rest.shift();
      continue;
    }
    if (arg === "--") {
      rest.shift();
      break;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      rest.shift();
      continue;
    }
    if (isEnvUnsafeSplitFlag(arg)) {
      return null;
    }
    if (isEnvInlineValueFlag(arg) || isEnvInlineShortValueFlag(arg)) {
      rest.shift();
      continue;
    }
    if (ENV_SEPARATE_VALUE_FLAGS.has(arg)) {
      rest.shift();
      if (rest.length === 0) {
        return null;
      }
      rest.shift();
      continue;
    }
    if (ENV_BOOLEAN_FLAGS.has(arg) || isEnvOptionalInlineValueFlag(arg)) {
      rest.shift();
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    break;
  }
  return rest;
}

function isEnvInlineValueFlag(arg: string): boolean {
  const separatorIndex = arg.indexOf("=");
  return separatorIndex > 0 && ENV_INLINE_VALUE_FLAGS.has(arg.slice(0, separatorIndex));
}

function isEnvInlineShortValueFlag(arg: string): boolean {
  return /^-[aCu].+/.test(arg);
}

function isEnvUnsafeSplitFlag(arg: string): boolean {
  return (
    ENV_UNSAFE_SPLIT_FLAGS.has(arg) || arg.startsWith("-S") || arg.startsWith("--split-string=")
  );
}

function isEnvOptionalInlineValueFlag(arg: string): boolean {
  return /^(?:--block-signal|--default-signal|--ignore-signal)(?:=|$)/.test(arg);
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = () => {
    if (current) {
      words.push(current);
      current = "";
    }
  };

  for (const char of input) {
    if (quote) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += "\\";
  }
  pushCurrent();
  return words;
}

function hasShellExecutionExpansion(segment: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    const next = segment[index + 1] ?? "";

    if (quote) {
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = null;
      }
      if (quote !== "'" && ((char === "$" && next === "(") || char === "`")) {
        return true;
      }
      escaped = false;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === "$" && next === "(") || char === "`") {
      return true;
    }
    if ((char === "<" || char === ">") && next === "(") {
      return true;
    }
    escaped = false;
  }
  return false;
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

function formatSentence(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}` : trimmed;
}

function formatRiskLevel(risk: ApprovalRiskLevel): string {
  return risk === "low" ? "Low" : risk === "medium" ? "Medium" : "High";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildDefaultRiskReason(
  risk: ApprovalRiskLevel,
  summaries: readonly CommandActionSummary[],
): string {
  const kinds = new Set(summaries.map((summary) => summary.kind));
  if (risk === "low" && kinds.size === 1 && kinds.has("format")) {
    return "Only formats a short status message. No files, network, or services changed.";
  }
  if (risk === "low" && kinds.has("process")) {
    return "Reads local process state. No network, service change, or delete step detected.";
  }
  if (risk === "low" && kinds.has("write")) {
    return "Only creates or checks workspace files. No network, service, or delete step detected.";
  }
  if (risk === "low" && (kinds.has("read") || kinds.has("service"))) {
    return "Reads local state or logs. No network, service change, or delete step detected.";
  }
  if (risk === "high") {
    return "This can make sensitive or hard-to-reverse changes. Review carefully before approving.";
  }
  return "May read sensitive data or change local state. Review before approving.";
}

function getCommandTargetArgs(command: string, args: readonly string[]): string[] {
  if (command === "[" || command === "test") {
    return args.filter(
      (arg) =>
        arg &&
        arg !== "!" &&
        arg !== "]" &&
        !arg.startsWith("-") &&
        !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg),
    );
  }
  if (
    ["awk", "cut", "echo", "jq", "pgrep", "printf", "ps", "sleep", "sort", "tr", "uniq"].includes(
      command,
    )
  ) {
    return [];
  }

  const optionValueFlags = getCommandOptionValueFlags(command);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg || arg === "]" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      const inlineValue = getInlineOptionValue(arg, optionValueFlags);
      if (inlineValue) {
        if (isSensitivePath(inlineValue) || isSystemPath(inlineValue)) {
          targets.push(inlineValue);
        }
        continue;
      }
      if (optionValueFlags.has(arg) && args[index + 1]) {
        const value = args[index + 1] ?? "";
        if (isSensitivePath(value) || isSystemPath(value)) {
          targets.push(value);
        }
        index += 1;
      }
      continue;
    }
    if ((command === "head" || command === "tail") && /^\d+$/.test(arg)) {
      continue;
    }
    targets.push(arg);
  }
  return targets;
}

function hasFindDeletePredicate(args: readonly string[]): boolean {
  return args.some((arg) => FIND_DELETE_PREDICATES.has(arg));
}

function hasFindExecPredicate(args: readonly string[]): boolean {
  return args.some((arg) => FIND_EXEC_PREDICATES.has(arg));
}

function getFindOutputFileTargets(args: readonly string[]): {
  ambiguous: boolean;
  targets: string[];
} {
  const targets: string[] = [];
  let ambiguous = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const inlineValue = getInlineOptionValue(arg, FIND_OUTPUT_FILE_PREDICATES);
    if (inlineValue) {
      targets.push(inlineValue);
      continue;
    }
    if (!FIND_OUTPUT_FILE_PREDICATES.has(arg)) {
      continue;
    }
    const target = args[index + 1];
    if (target) {
      targets.push(target);
      index += 1;
    } else {
      ambiguous = true;
    }
  }
  return { ambiguous, targets };
}

function hasSedInPlaceOption(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="),
  );
}

function getFindSearchRoots(args: readonly string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (!arg || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      continue;
    }
    if (arg === "!" || arg === "(" || arg === ")" || arg.startsWith("-")) {
      break;
    }
    roots.push(arg);
  }
  return roots;
}

function getSedInPlaceTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  let hasExplicitProgram = false;
  let consumedImplicitProgram = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      continue;
    }
    if (
      arg === "-i" ||
      arg === "--in-place" ||
      arg.startsWith("-i") ||
      arg.startsWith("--in-place=")
    ) {
      continue;
    }
    if (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") {
      hasExplicitProgram = true;
      index += 1;
      continue;
    }
    if (
      arg.startsWith("-e") ||
      arg.startsWith("--expression=") ||
      arg.startsWith("-f") ||
      arg.startsWith("--file=")
    ) {
      hasExplicitProgram = true;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (!hasExplicitProgram && !consumedImplicitProgram) {
      consumedImplicitProgram = true;
      continue;
    }
    targets.push(arg);
  }
  return targets;
}

function hasRemoteShellCommand(args: readonly string[]): boolean {
  let sawHost = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return sawHost && args.slice(index + 1).some((value) => Boolean(value));
    }
    if (!sawHost && arg.startsWith("-")) {
      if (
        [
          "-b",
          "-c",
          "-D",
          "-E",
          "-e",
          "-F",
          "-I",
          "-i",
          "-J",
          "-L",
          "-l",
          "-m",
          "-O",
          "-o",
          "-p",
          "-Q",
          "-R",
          "-S",
          "-W",
          "-w",
        ].includes(arg) &&
        args[index + 1]
      ) {
        index += 1;
      }
      continue;
    }
    if (!sawHost) {
      sawHost = true;
      continue;
    }
    return true;
  }
  return false;
}

function getShellOutputRedirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of segment.matchAll(SHELL_OUTPUT_REDIRECTION_RE)) {
    const target = match[1]?.trim();
    if (target) {
      targets.push(stripShellWordQuotes(target));
    }
  }
  return targets;
}

function getShellInputRedirection(segment: string): {
  targets: string[];
  hasInputRedirection: boolean;
} {
  const targets: string[] = [];
  let hasInputRedirection = false;
  for (const match of segment.matchAll(SHELL_INPUT_REDIRECTION_RE)) {
    hasInputRedirection = true;
    const target = match[1]?.trim();
    if (!target) {
      continue;
    }
    const file = stripShellWordQuotes(target);
    if (file && file !== "-" && !file.startsWith("&") && !file.startsWith("(")) {
      targets.push(file);
    }
  }
  return { targets, hasInputRedirection };
}

function summarizeRedirectedWrite(
  redirectionTargets: readonly string[],
  sudoPrefix: { risk: "high"; reason: string } | null,
): CommandActionSummary {
  const touchesSensitivePath = redirectionTargets.some(isSensitivePath);
  const touchesSystemPath = redirectionTargets.some(isSystemPath);
  return withSudo(
    {
      text: `write terminal output into a file${formatTargets(redirectionTargets)}`,
      risk: touchesSensitivePath || touchesSystemPath ? "high" : "medium",
      kind: "write",
      reason:
        touchesSensitivePath || touchesSystemPath
          ? "Shell redirection writes to a sensitive or system path."
          : "Shell redirection can create or overwrite files.",
      showCommandPreview: true,
    },
    sudoPrefix,
  );
}

function summarizeNetworkCommand(
  command: string,
  args: readonly string[],
  segment: string,
): CommandActionSummary {
  const transfer = collectNetworkTransferOperands(command, args, segment);
  const uploadFiles = uniqueStrings(transfer.uploadFiles);
  const outputFiles = uniqueStrings(transfer.outputFiles);
  const configFiles = uniqueStrings(transfer.configFiles);
  const credentialFiles = uniqueStrings(transfer.credentialFiles);
  const cookieJarFiles = uniqueStrings(transfer.cookieJarFiles);
  if (
    uploadFiles.length > 0 ||
    outputFiles.length > 0 ||
    configFiles.length > 0 ||
    cookieJarFiles.length > 0 ||
    transfer.usesAmbiguousStdinUpload ||
    transfer.usesAmbiguousConfig ||
    credentialFiles.length > 0 ||
    transfer.usesDefaultCredentialSource ||
    transfer.usesAmbiguousCredentialSource ||
    transfer.usesInlineCredentialSource ||
    transfer.usesUrlCredentialSource ||
    transfer.usesHeaderCredentialSource
  ) {
    const actions: string[] = [];
    if (uploadFiles.length > 0) {
      actions.push(`upload local files${formatTargets(uploadFiles)}`);
    }
    if (transfer.usesAmbiguousStdinUpload) {
      actions.push("upload data from standard input");
    }
    if (configFiles.length > 0) {
      actions.push(`load network options from config file${formatTargets(configFiles)}`);
    }
    if (transfer.usesAmbiguousConfig) {
      actions.push("load network options from standard input");
    }
    if (credentialFiles.length > 0) {
      actions.push(`read network credentials from file${formatTargets(credentialFiles)}`);
    }
    if (transfer.usesDefaultCredentialSource) {
      actions.push("read network credentials from the default netrc file");
    }
    if (transfer.usesAmbiguousCredentialSource) {
      actions.push("read network credentials from an ambiguous source");
    }
    if (transfer.usesInlineCredentialSource) {
      actions.push("send network credentials from command options");
    }
    if (transfer.usesUrlCredentialSource) {
      actions.push("send network credentials embedded in URLs");
    }
    if (transfer.usesHeaderCredentialSource) {
      actions.push("send network credentials in headers");
    }
    if (outputFiles.length > 0) {
      actions.push(`write network output to local files${formatTargets(outputFiles)}`);
    }
    if (cookieJarFiles.length > 0) {
      actions.push(`write network cookies to local files${formatTargets(cookieJarFiles)}`);
    }
    if (transfer.urls.length > 0) {
      actions.push(`contact${formatNetworkTargetList(transfer.urls)}`);
    }
    return {
      text: actions.join("; "),
      risk: "high",
      kind: "network",
      reason: buildNetworkTransferRiskReason(
        uploadFiles,
        outputFiles,
        transfer.usesAmbiguousStdinUpload,
        configFiles,
        transfer.usesAmbiguousConfig,
        credentialFiles,
        transfer.usesDefaultCredentialSource,
        transfer.usesAmbiguousCredentialSource,
        transfer.usesInlineCredentialSource,
        transfer.usesUrlCredentialSource,
        transfer.usesHeaderCredentialSource,
        cookieJarFiles,
      ),
      showCommandPreview: true,
    };
  }
  return {
    text: `make a network request or download data${formatNetworkTargetList(
      transfer.urls.length > 0
        ? transfer.urls
        : args.filter((arg) => isNetworkUrl(arg)).map((arg) => formatNetworkUrl(arg)),
    )}`,
    risk: "medium",
    kind: "network",
    reason: "Network commands can send or fetch data outside this machine.",
  };
}

function collectNetworkTransferOperands(
  command: string,
  args: readonly string[],
  segment: string,
): {
  uploadFiles: string[];
  outputFiles: string[];
  configFiles: string[];
  credentialFiles: string[];
  cookieJarFiles: string[];
  urls: string[];
  usesAmbiguousStdinUpload: boolean;
  usesAmbiguousConfig: boolean;
  usesDefaultCredentialSource: boolean;
  usesAmbiguousCredentialSource: boolean;
  usesInlineCredentialSource: boolean;
  usesUrlCredentialSource: boolean;
  usesHeaderCredentialSource: boolean;
} {
  const uploadFiles: string[] = [];
  const outputFiles: string[] = [...getShellOutputRedirectionTargets(segment)];
  const configFiles: string[] = [];
  const credentialFiles: string[] = [];
  const cookieJarFiles: string[] = [];
  const urls: string[] = [];
  const inputRedirection = getShellInputRedirection(segment);
  let usesAmbiguousStdinUpload = false;
  let usesAmbiguousConfig = false;
  let usesDefaultCredentialSource = false;
  let usesAmbiguousCredentialSource = false;
  let usesInlineCredentialSource = false;
  let usesUrlCredentialSource = false;
  let usesHeaderCredentialSource = false;
  const curlUsesGet = command === "curl" && args.some((value) => CURL_GET_FLAGS.has(value));
  const recordStdinUpload = () => {
    if (inputRedirection.targets.length > 0) {
      uploadFiles.push(...inputRedirection.targets);
      return;
    }
    usesAmbiguousStdinUpload = true;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (isNetworkUrl(arg)) {
      urls.push(formatNetworkUrl(arg));
      if (hasNetworkUrlCredentials(arg)) {
        usesUrlCredentialSource = true;
      }
    }

    const urlValue = command === "curl" ? takeFlagValue(args, index, CURL_URL_FLAGS) : null;
    if (urlValue) {
      if (isNetworkUrl(urlValue.value)) {
        urls.push(formatNetworkUrl(urlValue.value));
        if (hasNetworkUrlCredentials(urlValue.value)) {
          usesUrlCredentialSource = true;
        }
      }
      index = Math.max(index, urlValue.nextIndex);
      continue;
    }

    const configValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_CONFIG_FLAGS, ["-K"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_CONFIG_FLAGS)
          : null;
    if (configValue) {
      const files = extractPlainLocalFileOperands(configValue.value);
      if (files.length > 0) {
        configFiles.push(...files);
      } else {
        usesAmbiguousConfig = true;
      }
      index = Math.max(index, configValue.nextIndex);
      continue;
    }

    const netrcFileValue =
      command === "curl" ? takeFlagValue(args, index, CURL_NETRC_FILE_FLAGS) : null;
    if (netrcFileValue) {
      const files = extractPlainLocalFileOperands(netrcFileValue.value);
      if (files.length > 0) {
        credentialFiles.push(...files);
      } else {
        usesAmbiguousCredentialSource = true;
      }
      index = Math.max(index, netrcFileValue.nextIndex);
      continue;
    }
    if (command === "curl" && CURL_NETRC_FILE_FLAGS.has(arg)) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    if (command === "curl" && CURL_NETRC_FLAGS.has(arg)) {
      usesDefaultCredentialSource = true;
      continue;
    }

    const credentialFileValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_CREDENTIAL_FILE_FLAGS, ["-E"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_CREDENTIAL_FILE_FLAGS)
          : null;
    if (credentialFileValue) {
      const files = extractCredentialFileOperands(credentialFileValue.value);
      if (files.length > 0) {
        credentialFiles.push(...files);
      } else {
        usesAmbiguousCredentialSource = true;
      }
      index = Math.max(index, credentialFileValue.nextIndex);
      continue;
    }
    if (
      (command === "curl" && CURL_CREDENTIAL_FILE_FLAGS.has(arg)) ||
      (command === "wget" && WGET_CREDENTIAL_FILE_FLAGS.has(arg))
    ) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const authValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_AUTH_VALUE_FLAGS, ["-u", "-U"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_AUTH_VALUE_FLAGS)
          : null;
    if (authValue) {
      usesInlineCredentialSource = true;
      index = Math.max(index, authValue.nextIndex);
      continue;
    }
    if (
      (command === "curl" && CURL_AUTH_VALUE_FLAGS.has(arg)) ||
      (command === "wget" && WGET_AUTH_VALUE_FLAGS.has(arg))
    ) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const headerValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_HEADER_FLAGS, ["-H"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_HEADER_FLAGS)
          : null;
    if (headerValue) {
      const headerSource = extractHeaderFileSource(headerValue.value);
      if (headerSource.files.length > 0) {
        credentialFiles.push(...headerSource.files);
        usesHeaderCredentialSource = true;
      } else if (headerSource.usesStdin) {
        if (inputRedirection.targets.length > 0) {
          credentialFiles.push(...inputRedirection.targets);
        } else {
          usesAmbiguousCredentialSource = true;
        }
        usesHeaderCredentialSource = true;
      } else if (isCredentialHeaderValue(headerValue.value)) {
        usesHeaderCredentialSource = true;
      }
      index = Math.max(index, headerValue.nextIndex);
      continue;
    }
    if (
      (command === "curl" && CURL_HEADER_FLAGS.has(arg)) ||
      (command === "wget" && WGET_HEADER_FLAGS.has(arg))
    ) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const cookieValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_COOKIE_FLAGS, ["-b"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_COOKIE_FLAGS)
          : null;
    if (cookieValue) {
      const files =
        command === "curl"
          ? extractCurlCookieFiles(cookieValue.value)
          : extractPlainLocalFileOperands(cookieValue.value);
      if (files.length > 0) {
        credentialFiles.push(...files);
      } else if (command === "curl") {
        usesInlineCredentialSource = true;
      } else {
        usesAmbiguousCredentialSource = true;
      }
      index = Math.max(index, cookieValue.nextIndex);
      continue;
    }
    if (
      (command === "curl" && CURL_COOKIE_FLAGS.has(arg)) ||
      (command === "wget" && WGET_COOKIE_FLAGS.has(arg))
    ) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const cookieJarValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_COOKIE_JAR_FLAGS, ["-c"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_COOKIE_JAR_FLAGS)
          : null;
    if (cookieJarValue) {
      const files = extractPlainLocalFileOperands(cookieJarValue.value);
      if (files.length > 0) {
        cookieJarFiles.push(...files);
      } else {
        usesAmbiguousCredentialSource = true;
      }
      index = Math.max(index, cookieJarValue.nextIndex);
      continue;
    }
    if (
      (command === "curl" && CURL_COOKIE_JAR_FLAGS.has(arg)) ||
      (command === "wget" && WGET_COOKIE_JAR_FLAGS.has(arg))
    ) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const urlQueryValue =
      command === "curl" ? takeFlagValue(args, index, CURL_URL_QUERY_FLAGS) : null;
    if (urlQueryValue) {
      const querySource = analyzeCurlUrlQueryValue(urlQueryValue.value);
      if (querySource.files.length > 0) {
        credentialFiles.push(...querySource.files);
        usesUrlCredentialSource = true;
      }
      if (querySource.usesStdin) {
        if (inputRedirection.targets.length > 0) {
          credentialFiles.push(...inputRedirection.targets);
        } else {
          usesAmbiguousCredentialSource = true;
        }
        usesUrlCredentialSource = true;
      }
      if (querySource.hasSensitiveQueryKey) {
        usesUrlCredentialSource = true;
      }
      if (querySource.ambiguous) {
        usesAmbiguousCredentialSource = true;
      }
      index = Math.max(index, urlQueryValue.nextIndex);
      continue;
    }
    if (command === "curl" && CURL_URL_QUERY_FLAGS.has(arg)) {
      usesAmbiguousCredentialSource = true;
      continue;
    }

    const uploadValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_UPLOAD_FILE_FLAGS, ["-T"])
        : takeFlagValue(args, index, WGET_UPLOAD_FILE_FLAGS);
    if (uploadValue) {
      uploadFiles.push(...extractPlainLocalFileOperands(uploadValue.value));
      if (isNetworkStdinOperand(uploadValue.value)) {
        recordStdinUpload();
      }
      index = Math.max(index, uploadValue.nextIndex);
      continue;
    }

    const bodyValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_UPLOAD_BODY_FLAGS, ["-d", "-F"])
        : command === "wget"
          ? takeFlagValue(args, index, WGET_UPLOAD_BODY_FLAGS)
          : null;
    if (bodyValue) {
      if (curlUsesGet) {
        const querySource = analyzeCurlUrlQueryValue(bodyValue.value);
        if (querySource.files.length > 0) {
          credentialFiles.push(...querySource.files);
          usesUrlCredentialSource = true;
        }
        if (querySource.usesStdin) {
          if (inputRedirection.targets.length > 0) {
            credentialFiles.push(...inputRedirection.targets);
          } else {
            usesAmbiguousCredentialSource = true;
          }
          usesUrlCredentialSource = true;
        }
        if (querySource.hasSensitiveQueryKey) {
          usesUrlCredentialSource = true;
        }
        if (querySource.ambiguous) {
          usesAmbiguousCredentialSource = true;
        }
      } else {
        const credentialSource = analyzeCurlBodyCredentialValue(bodyValue.value);
        if (credentialSource.files.length > 0) {
          credentialFiles.push(...credentialSource.files);
        }
        if (credentialSource.usesStdin) {
          if (inputRedirection.targets.length > 0) {
            credentialFiles.push(...inputRedirection.targets);
          } else {
            usesAmbiguousCredentialSource = true;
          }
        }
        if (credentialSource.hasSensitiveBodyKey) {
          usesInlineCredentialSource = true;
        }
        if (credentialSource.ambiguous) {
          usesAmbiguousCredentialSource = true;
        }
        if (command === "curl") {
          uploadFiles.push(...extractCurlBodyFileOperands(bodyValue.value));
          if (isCurlBodyStdinOperand(bodyValue.value)) {
            recordStdinUpload();
          }
        }
      }
      index = Math.max(index, bodyValue.nextIndex);
      continue;
    }

    const outputValue =
      command === "curl"
        ? takeFlagValue(args, index, CURL_OUTPUT_FLAGS, ["-D", "-o"])
        : takeFlagValue(args, index, WGET_OUTPUT_FLAGS, ["-O", "-P", "-a", "-o"]);
    if (outputValue) {
      outputFiles.push(...extractPlainLocalFileOperands(outputValue.value));
      index = Math.max(index, outputValue.nextIndex);
    }
  }
  return {
    uploadFiles,
    outputFiles,
    configFiles,
    credentialFiles,
    cookieJarFiles,
    urls: uniqueStrings(urls),
    usesAmbiguousStdinUpload,
    usesAmbiguousConfig,
    usesDefaultCredentialSource,
    usesAmbiguousCredentialSource,
    usesInlineCredentialSource,
    usesUrlCredentialSource,
    usesHeaderCredentialSource,
  };
}

function takeFlagValue(
  args: readonly string[],
  index: number,
  valueFlags: ReadonlySet<string>,
  inlineShortFlags: readonly string[] = [],
): { value: string; nextIndex: number } | null {
  const arg = args[index] ?? "";
  const separatorIndex = arg.indexOf("=");
  if (separatorIndex > 0 && valueFlags.has(arg.slice(0, separatorIndex))) {
    return { value: arg.slice(separatorIndex + 1), nextIndex: index };
  }
  if (valueFlags.has(arg)) {
    const value = args[index + 1];
    return value ? { value, nextIndex: index + 1 } : null;
  }
  for (const flag of inlineShortFlags) {
    if (arg.startsWith(flag) && arg.length > flag.length) {
      return { value: arg.slice(flag.length), nextIndex: index };
    }
  }
  return null;
}

function extractPlainLocalFileOperands(value: string): string[] {
  const file = stripNetworkFileOperandPrefix(value.trim());
  return file && file !== "-" ? [file] : [];
}

function extractCredentialFileOperands(value: string): string[] {
  const trimmed = stripShellWordQuotes(value.trim());
  if (!trimmed || trimmed === "-") {
    return [];
  }
  const filePart = /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed : (trimmed.split(":")[0] ?? "");
  return extractPlainLocalFileOperands(filePart);
}

function isNetworkStdinOperand(value: string): boolean {
  return stripNetworkFileOperandPrefix(value.trim()) === "-";
}

function isCredentialHeaderValue(value: string): boolean {
  return /^(?:(?:proxy-)?authorization|(?:set-)?cookie|[-a-z0-9_]*(?:api[-_]?key|auth|credential|password|secret|session|token)[-a-z0-9_]*)\s*:/i.test(
    stripShellWordQuotes(value.trim()),
  );
}

function extractHeaderFileSource(value: string): { files: string[]; usesStdin: boolean } {
  const trimmed = stripShellWordQuotes(value.trim());
  if (!trimmed.startsWith("@")) {
    return { files: [], usesStdin: false };
  }
  const file = stripNetworkFileOperandPrefix(trimmed);
  if (file === "-") {
    return { files: [], usesStdin: true };
  }
  return { files: extractPlainLocalFileOperands(trimmed), usesStdin: false };
}

function extractCurlCookieFiles(value: string): string[] {
  const trimmed = stripShellWordQuotes(value.trim());
  if (!trimmed || trimmed === "-" || /[=;]/.test(trimmed)) {
    return [];
  }
  return extractPlainLocalFileOperands(trimmed);
}

function analyzeCurlUrlQueryValue(value: string): {
  files: string[];
  usesStdin: boolean;
  hasSensitiveQueryKey: boolean;
  ambiguous: boolean;
} {
  const trimmed = stripShellWordQuotes(value.trim());
  if (!trimmed) {
    return { files: [], usesStdin: false, hasSensitiveQueryKey: false, ambiguous: true };
  }
  const normalized = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const fileOperand = extractCurlUrlQueryFileOperand(normalized);
  if (fileOperand === "") {
    return { files: [], usesStdin: false, hasSensitiveQueryKey: false, ambiguous: true };
  }
  if (fileOperand === "-") {
    return { files: [], usesStdin: true, hasSensitiveQueryKey: false, ambiguous: false };
  }
  if (fileOperand) {
    return {
      files: extractPlainLocalFileOperands(fileOperand),
      usesStdin: false,
      hasSensitiveQueryKey: true,
      ambiguous: false,
    };
  }
  return {
    files: [],
    usesStdin: false,
    hasSensitiveQueryKey: hasSensitiveCurlUrlQueryValue(normalized),
    ambiguous: false,
  };
}

function analyzeCurlBodyCredentialValue(value: string): {
  files: string[];
  usesStdin: boolean;
  hasSensitiveBodyKey: boolean;
  ambiguous: boolean;
} {
  const trimmed = stripShellWordQuotes(value.trim());
  if (!trimmed) {
    return { files: [], usesStdin: false, hasSensitiveBodyKey: false, ambiguous: false };
  }
  const files: string[] = [];
  let usesStdin = false;
  let ambiguous = false;
  let hasSensitiveBodyKey = hasSensitiveCurlBodyValue(trimmed);
  const keyedFile = /^([^=@<;\s]+)(?:=)?([@<])(.+)$/.exec(trimmed);
  if (keyedFile && isSensitiveUrlQueryKey(keyedFile[1] ?? "")) {
    hasSensitiveBodyKey = true;
    const fileOperand = stripNetworkFileOperandPrefix(
      (keyedFile[3] ?? "").split(";")[0]?.trim() ?? "",
    );
    if (!fileOperand) {
      ambiguous = true;
    } else if (fileOperand === "-") {
      usesStdin = true;
    } else {
      files.push(...extractPlainLocalFileOperands(fileOperand));
    }
  }
  return {
    files,
    usesStdin,
    hasSensitiveBodyKey,
    ambiguous,
  };
}

function hasSensitiveCurlBodyValue(value: string): boolean {
  return hasSensitiveCurlUrlQueryValue(value) || hasSensitiveJsonLikeCredentialKey(value);
}

function extractCurlUrlQueryFileOperand(value: string): string | null {
  if (value.startsWith("@")) {
    return stripNetworkFileOperandPrefix(value);
  }
  const namedFile = /^[^=]+@(.+)$/.exec(value);
  if (!namedFile) {
    return null;
  }
  return stripNetworkFileOperandPrefix(namedFile[1] ?? "");
}

function hasSensitiveCurlUrlQueryValue(value: string): boolean {
  for (const match of value.matchAll(/(?:^|[?&=])([^=\s&#]+)=/gi)) {
    if (isSensitiveUrlQueryKey(match[1] ?? "")) {
      return true;
    }
  }
  return false;
}

function hasSensitiveJsonLikeCredentialKey(value: string): boolean {
  for (const match of value.matchAll(/["']?([A-Za-z0-9_.-]+)["']?\s*:/gi)) {
    if (isSensitiveUrlQueryKey(match[1] ?? "")) {
      return true;
    }
  }
  return false;
}

function extractCurlBodyFileOperands(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("@")) {
    return extractPlainLocalFileOperands(trimmed);
  }
  const namedFile = /^[^=]+@(.+)$/.exec(trimmed);
  if (namedFile) {
    return extractPlainLocalFileOperands(namedFile[1] ?? "");
  }
  const files: string[] = [];
  const formFilePattern = /(?:^|=)([@<])([^;]+)/g;
  for (const match of trimmed.matchAll(formFilePattern)) {
    const file = stripNetworkFileOperandPrefix(match[2]?.trim() ?? "");
    if (file && file !== "-") {
      files.push(file);
    }
  }
  return files;
}

function isCurlBodyStdinOperand(value: string): boolean {
  const trimmed = stripShellWordQuotes(value.trim());
  if (trimmed === "@-" || trimmed === "<-") {
    return true;
  }
  if (/^[^=]+[@<]-$/.test(trimmed)) {
    return true;
  }
  return /(?:^|=)[@<]-(?:;|$)/.test(trimmed);
}

function stripNetworkFileOperandPrefix(value: string): string {
  return stripShellWordQuotes(value).replace(/^@/, "");
}

function buildNetworkTransferRiskReason(
  uploadFiles: readonly string[],
  outputFiles: readonly string[],
  usesAmbiguousStdinUpload = false,
  configFiles: readonly string[] = [],
  usesAmbiguousConfig = false,
  credentialFiles: readonly string[] = [],
  usesDefaultCredentialSource = false,
  usesAmbiguousCredentialSource = false,
  usesInlineCredentialSource = false,
  usesUrlCredentialSource = false,
  usesHeaderCredentialSource = false,
  cookieJarFiles: readonly string[] = [],
): string {
  if (uploadFiles.some(isSensitivePath)) {
    return "This network command can send local sensitive files outside this machine.";
  }
  if (cookieJarFiles.some((file) => isSensitivePath(file) || isSystemPath(file))) {
    return "This network command can overwrite sensitive or system paths.";
  }
  if (
    credentialFiles.length > 0 ||
    usesDefaultCredentialSource ||
    usesAmbiguousCredentialSource ||
    usesInlineCredentialSource ||
    usesUrlCredentialSource ||
    usesHeaderCredentialSource
  ) {
    return "Network credential options can expose cookies, tokens, or login/password data.";
  }
  if (outputFiles.some((file) => isSensitivePath(file) || isSystemPath(file))) {
    return "This network command can overwrite sensitive or system paths.";
  }
  if (configFiles.length > 0 || usesAmbiguousConfig) {
    return "Network config files can add hidden upload, output, or credential options.";
  }
  if (usesAmbiguousStdinUpload) {
    return "This network command can send piped or redirected input outside this machine.";
  }
  if (cookieJarFiles.length > 0) {
    return "Cookie jar options can save login or session credentials from network responses.";
  }
  if (uploadFiles.length > 0) {
    return "This network command can send local files outside this machine.";
  }
  return "This network command can create or overwrite local files from network data.";
}

function getCommandOptionValueFlags(command: string): ReadonlySet<string> {
  if (command === "grep" || command === "rg") {
    return GREP_OPTION_VALUE_FLAGS;
  }
  if (command === "head" || command === "tail") {
    return HEAD_TAIL_OPTION_VALUE_FLAGS;
  }
  if (command === "sed") {
    return SED_OPTION_VALUE_FLAGS;
  }
  return EMPTY_OPTION_VALUE_FLAGS;
}

function getInlineOptionValue(arg: string, optionValueFlags: ReadonlySet<string>): string | null {
  const separatorIndex = arg.indexOf("=");
  if (separatorIndex < 1) {
    return null;
  }
  const option = arg.slice(0, separatorIndex);
  if (!optionValueFlags.has(option)) {
    return null;
  }
  return arg.slice(separatorIndex + 1);
}

function formatReadFileAction(command: string, args: readonly string[]): string {
  if (args.some((arg) => arg.includes("/tmp/openclaw-agent-routes/"))) {
    return command === "tail" || command === "head"
      ? "read recent agent-route log output"
      : "read agent-route log output";
  }
  if (args.some((arg) => /\.log(?:\b|$)|\/logs?\//i.test(arg))) {
    return command === "tail" || command === "head"
      ? "read recent local log output"
      : "read local log output";
  }
  return `read file contents${formatTargets(args)}`;
}

function formatTargets(args: readonly string[]): string {
  const targets = args.filter((arg) => arg && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
  if (targets.length === 0) {
    return "";
  }
  const shown = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `: ${shown}, and ${targets.length - 3} more` : `: ${shown}`;
}

function formatNetworkTargetList(targets: readonly string[]): string {
  if (targets.length === 0) {
    return "";
  }
  const shown = targets.slice(0, 2).join(", ");
  return targets.length > 2 ? `: ${shown}, and ${targets.length - 2} more` : `: ${shown}`;
}

function formatNetworkUrl(arg: string): string {
  try {
    const url = new URL(stripShellWordQuotes(arg.trim()));
    return `${url.origin}${url.pathname}`;
  } catch {
    return arg;
  }
}

function isNetworkUrl(arg: string): boolean {
  return /^https?:\/\//i.test(stripShellWordQuotes(arg.trim()));
}

function hasNetworkUrlCredentials(arg: string): boolean {
  const value = stripShellWordQuotes(arg.trim());
  try {
    const url = new URL(value);
    return (
      url.username.length > 0 ||
      url.password.length > 0 ||
      Array.from(url.searchParams.keys()).some(isSensitiveUrlQueryKey)
    );
  } catch {
    if (/^https?:\/\/[^/\s@]+@/i.test(value)) {
      return true;
    }
    for (const match of value.matchAll(/[?&]([^=\s&#]+)=/gi)) {
      if (isSensitiveUrlQueryKey(match[1] ?? "")) {
        return true;
      }
    }
    return false;
  }
}

function isSensitiveUrlQueryKey(key: string): boolean {
  const normalized = decodeURIComponentSafe(key).toLowerCase();
  return /(?:^|[-_.])(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|id[-_]?token|jwt|password|passwd|refresh[-_]?token|secret|session|signature|token)(?:$|[-_.])/i.test(
    normalized,
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basename(command: string): string {
  return command.split("/").pop()?.trim() ?? command;
}

function cleanCommandName(command: string): string {
  return command.replace(/^['"]+|['"]+$/g, "");
}

function stripShellWordQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
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
  options?: {
    language?: PluginApprovalLanguage | null;
    allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
  },
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  const language = resolvePluginApprovalLanguage(options?.language);
  if (language === "simple" || language === "simple-technical") {
    lines.push(`${icon} Approval needed`);
    lines.push(...buildPlainEnglishApprovalLines(request.request));
    lines.push(
      ...buildApprovalDecisionHelpLines(request, {
        allowedDecisions: options?.allowedDecisions,
        includeManualFallback: language === "simple",
      }),
    );
    if (language === "simple") {
      return lines.join("\n");
    }
    lines.push("", "Technical details:", "Type: Plugin approval required");
  } else {
    lines.push(`${icon} Plugin approval required`);
  }
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
  const replyDecisions =
    options?.allowedDecisions != null
      ? normalizePluginApprovalAllowedDecisions(options.allowedDecisions)
      : resolvePluginApprovalRequestAllowedDecisions(request.request);
  if (replyDecisions.length > 0) {
    lines.push(`Reply with: /approve <id> ${replyDecisions.join("|")}`);
  }
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
