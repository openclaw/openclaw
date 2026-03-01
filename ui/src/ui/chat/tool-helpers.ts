/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

type ToolOutputFormatOptions = {
  toolName?: string;
  args?: unknown;
};

type ToolFormatContext = {
  toolName: string;
  argsRecord: Record<string, unknown> | null;
  parsedOutput: unknown | null;
  rawText: string;
  trimmedText: string;
};

type ReadEntry = {
  path: string | null;
  content: string | null;
};

type SearchResult = {
  title: string;
  url: string | null;
  snippet: string | null;
  source: string | null;
};

/**
 * Format tool output content for display in the sidebar.
 */
export function formatToolOutputForSidebar(
  text: string,
  options: ToolOutputFormatOptions = {},
): string {
  const normalizedToolName = normalizeToolName(options.toolName);
  const trimmed = text.trim();
  const parsedOutput = parseJsonLoose(trimmed);
  const argsRecord = asRecord(options.args);

  const context: ToolFormatContext = {
    toolName: normalizedToolName,
    argsRecord,
    parsedOutput,
    rawText: text,
    trimmedText: trimmed,
  };

  const readMarkdown = formatReadToolOutput(context);
  if (readMarkdown) {
    return readMarkdown;
  }

  const editMarkdown = formatEditToolOutput(context);
  if (editMarkdown) {
    return editMarkdown;
  }

  const writeMarkdown = formatWriteToolOutput(context);
  if (writeMarkdown) {
    return writeMarkdown;
  }

  const execMarkdown = formatExecToolOutput(context);
  if (execMarkdown) {
    return execMarkdown;
  }

  const webFetchMarkdown = formatWebFetchToolOutput(context);
  if (webFetchMarkdown) {
    return webFetchMarkdown;
  }

  const webSearchMarkdown = formatWebSearchToolOutput(context);
  if (webSearchMarkdown) {
    return webSearchMarkdown;
  }

  const browserMarkdown = formatBrowserToolOutput(context);
  if (browserMarkdown) {
    return browserMarkdown;
  }

  const messagingMarkdown = formatMessagingToolOutput(context);
  if (messagingMarkdown) {
    return messagingMarkdown;
  }

  const nodesMarkdown = formatNodesToolOutput(context);
  if (nodesMarkdown) {
    return nodesMarkdown;
  }

  const gatewayMarkdown = formatGatewayToolOutput(context);
  if (gatewayMarkdown) {
    return gatewayMarkdown;
  }

  if (parsedOutput != null) {
    try {
      return createCodeFence(JSON.stringify(parsedOutput, null, 2), "json");
    } catch {
      // Not serializable, continue to plain fallback.
    }
  }

  if (trimmed) {
    return renderOutputSection("Output", trimmed);
  }

  return text;
}

function normalizeToolName(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasToolSuffix(normalizedName: string, suffix: string): boolean {
  return normalizedName === suffix || new RegExp(`(^|[.:/_-])${suffix}$`).test(normalizedName);
}

function isReadToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "read");
}

function isEditToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "edit");
}

function isWriteToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "write");
}

function isExecToolName(normalizedName: string): boolean {
  return (
    hasToolSuffix(normalizedName, "exec") ||
    hasToolSuffix(normalizedName, "bash") ||
    hasToolSuffix(normalizedName, "process") ||
    hasToolSuffix(normalizedName, "exec_command")
  );
}

function isWebFetchToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "web_fetch") || hasToolSuffix(normalizedName, "fetch");
}

function isWebSearchToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "web_search") || hasToolSuffix(normalizedName, "search");
}

function isBrowserToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "browser") || hasToolSuffix(normalizedName, "playwright");
}

function isMessagingToolName(normalizedName: string): boolean {
  return (
    hasToolSuffix(normalizedName, "discord") ||
    hasToolSuffix(normalizedName, "slack") ||
    hasToolSuffix(normalizedName, "sendmessage") ||
    hasToolSuffix(normalizedName, "readmessages")
  );
}

function isNodesToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "nodes") || hasToolSuffix(normalizedName, "node");
}

function isGatewayToolName(normalizedName: string): boolean {
  return hasToolSuffix(normalizedName, "gateway");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  const value = pickValue(record, keys);
  return toOptionalString(value);
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  const value = pickValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function pickBoolean(record: Record<string, unknown> | null, keys: string[]): boolean | null {
  const value = pickValue(record, keys);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return null;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePath(value: unknown): string | null {
  const record = asRecord(value);
  return pickString(record, ["path", "file_path", "filePath"]);
}

function resolveDuration(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 2)} s`;
}

function truncateForPreview(text: string, maxChars = 4_000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... truncated (${text.length} chars total)`;
}

function appendBullet(lines: string[], label: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return;
  }
  const rendered = typeof value === "number" ? String(value) : value;
  if (!rendered.trim()) {
    return;
  }
  lines.push(`- **${label}:** ${rendered}`);
}

function renderOutputSection(title: string, output: string, language = "text"): string {
  return [`### ${title}`, "", createCodeFence(output, language)].join("\n");
}

function createCodeFence(content: string, language = ""): string {
  const runs = content.match(/`+/g) ?? [];
  const requiredLength = runs.reduce((max, run) => Math.max(max, run.length + 1), 3);
  const fence = "`".repeat(requiredLength);
  const lang = language.trim();
  return `${fence}${lang}\n${content}\n${fence}`;
}

function parseJsonLoose(value: string): unknown | null {
  if (!value || (!value.startsWith("{") && !value.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractTextFromContentArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function extractOutputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const simpleArray = value
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
    if (simpleArray.length > 0) {
      return simpleArray.join("\n");
    }
    return extractTextFromContentArray(value);
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const directText =
    pickString(record, ["text", "content", "body", "stdout", "stderr", "output", "result"]) ??
    extractTextFromContentArray(record.content);
  if (directText) {
    return directText;
  }
  return null;
}

function formatReadToolOutput(context: ToolFormatContext): string | null {
  if (!isReadToolName(context.toolName)) {
    return null;
  }
  const entries = collectReadEntries(context);
  if (entries.length === 0) {
    return null;
  }
  const lines = ["### Read Files", ""];
  for (const entry of entries) {
    const pathLabel = entry.path ?? "(unknown path)";
    lines.push(`- \`${pathLabel}\``);
  }
  const entriesWithContent = entries.filter((entry) => typeof entry.content === "string");
  if (entriesWithContent.length === 0) {
    lines.push("", "_No file content captured in tool output._");
    return lines.join("\n");
  }

  for (const [index, entry] of entriesWithContent.entries()) {
    const sectionTitle = entry.path ?? `File ${index + 1}`;
    lines.push("", `#### ${sectionTitle}`, "", createCodeFence(entry.content!, "text"));
  }
  return lines.join("\n");
}

function collectReadEntries(context: ToolFormatContext): ReadEntry[] {
  const entries: ReadEntry[] = [];
  collectReadEntriesFromValue(context.parsedOutput, entries);

  const argPath = resolvePath(context.argsRecord);
  const normalizedRawText = context.rawText.trim() ? context.rawText : null;
  if (entries.length === 0 && (argPath || normalizedRawText)) {
    entries.push({
      path: argPath,
      content: normalizedRawText,
    });
  }

  return dedupeReadEntries(entries);
}

function collectReadEntriesFromValue(value: unknown, out: ReadEntry[]) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReadEntriesFromValue(entry, out);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }

  const path = resolvePath(record);
  const content =
    pickString(record, ["content", "text"]) ?? extractTextFromContentArray(record.content);
  if (path || content) {
    out.push({ path, content });
  }

  const files = record.files;
  if (Array.isArray(files)) {
    collectReadEntriesFromValue(files, out);
  }
}

function dedupeReadEntries(entries: ReadEntry[]): ReadEntry[] {
  const seen = new Set<string>();
  const out: ReadEntry[] = [];
  for (const entry of entries) {
    const path = entry.path?.trim() || null;
    const content = entry.content ?? null;
    if (!path && !content) {
      continue;
    }
    const key = `${path ?? ""}\u0000${content ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ path, content });
  }
  return out;
}

function formatEditToolOutput(context: ToolFormatContext): string | null {
  if (!isEditToolName(context.toolName)) {
    return null;
  }
  const record = context.argsRecord;
  const oldText = pickString(record, ["old_string", "oldText"]);
  const newText = pickString(record, ["new_string", "newText", "content"]);
  if (oldText == null || newText == null) {
    return null;
  }
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  const diffBody = createLineDiff(oldLines, newLines);
  const path = resolvePath(record);
  const lines = ["### Edit Diff"];
  if (path) {
    lines.push("", `**File:** \`${path}\``);
  }
  lines.push("", createCodeFence(diffBody, "diff"));
  return lines.join("\n");
}

function formatWriteToolOutput(context: ToolFormatContext): string | null {
  if (!isWriteToolName(context.toolName)) {
    return null;
  }

  const outputRecord = asRecord(context.parsedOutput);
  const path = resolvePath(context.argsRecord) ?? resolvePath(outputRecord);
  const bytes =
    pickNumber(outputRecord, ["bytes", "size", "written", "writtenBytes"]) ??
    pickNumber(context.argsRecord, ["bytes", "size"]);
  const append = pickBoolean(context.argsRecord, ["append"]);
  const created = pickBoolean(outputRecord, ["created", "isNew"]);
  const updated = pickBoolean(outputRecord, ["updated", "overwritten", "replaced"]);

  let mode: string | null = null;
  if (created === true) {
    mode = "created";
  } else if (updated === true) {
    mode = "updated";
  } else if (append === true) {
    mode = "appended";
  }

  const preview =
    pickString(context.argsRecord, ["content", "text"]) ??
    pickString(outputRecord, ["content", "text"]) ??
    extractTextFromContentArray(outputRecord?.content);

  const lines = ["### Write Result", ""];
  appendBullet(lines, "File", path ? `\`${path}\`` : null);
  appendBullet(lines, "Bytes", bytes);
  appendBullet(lines, "Mode", mode);

  if (preview) {
    lines.push("", "#### Content Preview", "", createCodeFence(truncateForPreview(preview), "text"));
  } else if (context.trimmedText && context.parsedOutput == null) {
    lines.push("", createCodeFence(context.trimmedText, "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatExecToolOutput(context: ToolFormatContext): string | null {
  if (!isExecToolName(context.toolName)) {
    return null;
  }
  const outputRecord = asRecord(context.parsedOutput);
  const command = pickString(context.argsRecord, ["command", "cmd", "script"]);
  const exitCode = pickNumber(outputRecord, ["exitCode", "exit_code", "status", "code"]);
  const durationMs = pickNumber(outputRecord, ["durationMs", "duration_ms", "elapsedMs", "elapsed"]);
  const cwd = pickString(outputRecord, ["cwd", "workdir", "workingDirectory"]) ??
    pickString(context.argsRecord, ["cwd", "workdir"]);
  const stdout = pickString(outputRecord, ["stdout"]) ?? extractTextFromContentArray(outputRecord?.stdout);
  const stderr = pickString(outputRecord, ["stderr", "error", "err"]);
  const genericOutput = extractOutputText(context.parsedOutput);

  const lines = ["### Execution Result", ""];
  appendBullet(lines, "Command", command ? `\`${command}\`` : null);
  appendBullet(lines, "Exit Code", exitCode);
  appendBullet(lines, "Duration", resolveDuration(durationMs));
  appendBullet(lines, "Working Dir", cwd ? `\`${cwd}\`` : null);

  if (stdout) {
    lines.push("", "#### Stdout", "", createCodeFence(truncateForPreview(stdout), "text"));
  }
  if (stderr) {
    lines.push("", "#### Stderr", "", createCodeFence(truncateForPreview(stderr), "text"));
  }

  if (!stdout && !stderr && genericOutput && genericOutput !== context.trimmedText) {
    lines.push("", "#### Output", "", createCodeFence(truncateForPreview(genericOutput), "text"));
  }
  if (!stdout && !stderr && !genericOutput && context.trimmedText && context.parsedOutput == null) {
    lines.push("", "#### Output", "", createCodeFence(truncateForPreview(context.trimmedText), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatWebFetchToolOutput(context: ToolFormatContext): string | null {
  if (!isWebFetchToolName(context.toolName)) {
    return null;
  }

  const outputRecord = asRecord(context.parsedOutput);
  const url =
    pickString(context.argsRecord, ["url", "targetUrl"]) ??
    pickString(outputRecord, ["url", "targetUrl", "finalUrl", "final_url"]);
  const status =
    pickNumber(outputRecord, ["status", "statusCode", "status_code"]) ??
    pickString(outputRecord, ["status", "statusCode", "status_code"]);
  const contentType = pickString(outputRecord, ["contentType", "content_type", "mimeType"]);
  const method = pickString(context.argsRecord, ["method"]);
  const body =
    pickString(outputRecord, ["content", "text", "body", "markdown", "html"]) ??
    extractTextFromContentArray(outputRecord?.content) ??
    (context.parsedOutput == null ? context.trimmedText : null);

  const lines = ["### Fetch Result", ""];
  appendBullet(lines, "URL", url ?? null);
  appendBullet(lines, "Method", method);
  appendBullet(lines, "Status", status ? String(status) : null);
  appendBullet(lines, "Content Type", contentType);

  if (body) {
    lines.push("", "#### Body Preview", "", createCodeFence(truncateForPreview(body, 8_000), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatWebSearchToolOutput(context: ToolFormatContext): string | null {
  if (!isWebSearchToolName(context.toolName)) {
    return null;
  }

  const results = collectSearchResults(context.parsedOutput);
  const query = pickString(context.argsRecord, ["query", "q", "search"]);
  if (results.length === 0 && !query && !context.trimmedText) {
    return null;
  }

  const lines = ["### Search Results", ""];
  appendBullet(lines, "Query", query ? `\`${query}\`` : null);
  appendBullet(lines, "Matches", results.length);

  if (results.length === 0 && context.trimmedText) {
    lines.push("", createCodeFence(truncateForPreview(context.trimmedText), "text"));
    return lines.join("\n");
  }

  const limit = Math.min(results.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const result = results[index];
    lines.push("", `#### ${index + 1}. ${result.title}`);
    appendBullet(lines, "URL", result.url);
    appendBullet(lines, "Source", result.source);
    if (result.snippet) {
      lines.push("", createCodeFence(truncateForPreview(result.snippet, 2_000), "text"));
    }
  }

  if (results.length > limit) {
    lines.push("", `_Showing first ${limit} of ${results.length} results._`);
  }
  return lines.join("\n");
}

function collectSearchResults(value: unknown): SearchResult[] {
  const out: SearchResult[] = [];
  const pushResult = (entry: unknown) => {
    const record = asRecord(entry);
    if (!record) {
      return;
    }
    const title =
      pickString(record, ["title", "name", "headline"]) ??
      pickString(record, ["url", "link"]) ??
      "Result";
    const url = pickString(record, ["url", "link"]);
    const snippet = pickString(record, ["snippet", "text", "description", "content"]);
    const source = pickString(record, ["source", "domain", "site"]);
    out.push({ title, url, snippet, source });
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      pushResult(entry);
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) {
    return out;
  }

  const containers = [
    record.results,
    record.items,
    record.hits,
    record.data,
    record.documents,
    record.web,
  ];
  for (const container of containers) {
    if (!Array.isArray(container)) {
      continue;
    }
    for (const entry of container) {
      pushResult(entry);
    }
  }

  if (out.length === 0) {
    pushResult(record);
  }

  return out;
}

function formatBrowserToolOutput(context: ToolFormatContext): string | null {
  if (!isBrowserToolName(context.toolName)) {
    return null;
  }
  const action = pickString(context.argsRecord, ["action", "fn", "tool"]) ?? "act";
  const target =
    pickString(context.argsRecord, ["targetUrl", "url", "targetId", "ref", "element"]) ??
    pickString(context.argsRecord, ["node", "nodeId"]);
  const outputText = extractOutputText(context.parsedOutput) ?? (context.parsedOutput == null ? context.trimmedText : null);

  const lines = ["### Browser Action", ""];
  appendBullet(lines, "Action", action);
  appendBullet(lines, "Target", target);

  if (outputText) {
    lines.push("", "#### Result", "", createCodeFence(truncateForPreview(outputText, 8_000), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatMessagingToolOutput(context: ToolFormatContext): string | null {
  if (!isMessagingToolName(context.toolName)) {
    return null;
  }
  const channel = hasToolSuffix(context.toolName, "discord") ? "Discord" : "Slack";
  const action = pickString(context.argsRecord, ["action", "fn", "tool"]) ?? "operation";
  const target =
    pickString(context.argsRecord, ["to", "channelId", "guildId", "userId"]) ??
    pickString(context.argsRecord, ["messageId"]);
  const messagePreview = pickString(context.argsRecord, ["content", "text", "question"]);
  const outputText = extractOutputText(context.parsedOutput) ?? (context.parsedOutput == null ? context.trimmedText : null);

  const lines = [`### ${channel} Action`, ""];
  appendBullet(lines, "Action", action);
  appendBullet(lines, "Target", target);
  if (messagePreview) {
    lines.push("", "#### Message Preview", "", createCodeFence(truncateForPreview(messagePreview, 2_000), "text"));
  }
  if (outputText) {
    lines.push("", "#### Result", "", createCodeFence(truncateForPreview(outputText, 8_000), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatNodesToolOutput(context: ToolFormatContext): string | null {
  if (!isNodesToolName(context.toolName)) {
    return null;
  }
  const action = pickString(context.argsRecord, ["action", "fn", "tool"]) ?? "operation";
  const node = pickString(context.argsRecord, ["node", "nodeId", "id"]);
  const duration =
    pickNumber(context.argsRecord, ["durationMs", "duration_ms", "duration"]) ??
    pickNumber(asRecord(context.parsedOutput), ["durationMs", "duration_ms", "duration"]);
  const media = pickString(context.argsRecord, ["facing", "deviceId", "screenIndex"]);
  const outputText = extractOutputText(context.parsedOutput) ?? (context.parsedOutput == null ? context.trimmedText : null);

  const lines = ["### Node Action", ""];
  appendBullet(lines, "Action", action);
  appendBullet(lines, "Node", node);
  appendBullet(lines, "Duration", resolveDuration(duration));
  appendBullet(lines, "Media", media);
  if (outputText) {
    lines.push("", "#### Result", "", createCodeFence(truncateForPreview(outputText, 8_000), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function formatGatewayToolOutput(context: ToolFormatContext): string | null {
  if (!isGatewayToolName(context.toolName)) {
    return null;
  }
  const action = pickString(context.argsRecord, ["action", "fn", "tool"]) ?? "operation";
  const reason = pickString(context.argsRecord, ["reason"]);
  const delay =
    pickNumber(context.argsRecord, ["delayMs", "restartDelayMs"]) ??
    pickNumber(asRecord(context.parsedOutput), ["delayMs", "restartDelayMs"]);
  const outputText = extractOutputText(context.parsedOutput) ?? (context.parsedOutput == null ? context.trimmedText : null);

  const lines = ["### Gateway Action", ""];
  appendBullet(lines, "Action", action);
  appendBullet(lines, "Reason", reason);
  appendBullet(lines, "Delay", resolveDuration(delay));
  if (outputText) {
    lines.push("", "#### Result", "", createCodeFence(truncateForPreview(outputText, 8_000), "text"));
  }

  if (lines.length <= 2 && !context.trimmedText) {
    return null;
  }
  return lines.join("\n");
}

function createLineDiff(oldLines: string[], newLines: string[]): string {
  const maxGrid = 50_000;
  if (oldLines.length * newLines.length > maxGrid) {
    const removed = oldLines.map((line) => `-${line}`);
    const added = newLines.map((line) => `+${line}`);
    return [...removed, ...added].join("\n");
  }

  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${oldLines[i]}`);
      i += 1;
      continue;
    }
    out.push(`+${newLines[j]}`);
    j += 1;
  }

  while (i < oldLines.length) {
    out.push(`-${oldLines[i]}`);
    i += 1;
  }
  while (j < newLines.length) {
    out.push(`+${newLines[j]}`);
    j += 1;
  }
  return out.join("\n");
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
