import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import { isPathInside } from "./scan-paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillScanSeverity = "info" | "warn" | "critical";

export type SkillScanFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  file: string;
  line: number;
  message: string;
  evidence: string;
};

export type SkillScanSummary = {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: SkillScanFinding[];
};

export type SkillScanOptions = {
  excludeTestFiles?: boolean;
  includeFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
};

// ---------------------------------------------------------------------------
// Scannable extensions
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".mts", ".cts", ".jsx", ".tsx"]);

const MARKDOWN_EXTENSIONS = new Set([".md"]);

const SCANNABLE_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...MARKDOWN_EXTENSIONS]);

const DEFAULT_MAX_SCAN_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const FILE_SCAN_CACHE_MAX = 5000;
const DIR_ENTRY_CACHE_MAX = 5000;
const TEST_DIRECTORY_NAMES = new Set(["__fixtures__", "__mocks__", "__tests__", "test", "tests"]);
const TEST_FILE_NAME_PATTERN = /\.(?:mock|spec|test)\.[^.]+$/i;

type FileScanCacheEntry = {
  size: number;
  mtimeMs: number;
  maxFileBytes: number;
  scanned: boolean;
  findings: SkillScanFinding[];
};

const FILE_SCAN_CACHE = new Map<string, FileScanCacheEntry>();
type CachedDirEntry = {
  name: string;
  kind: "file" | "dir";
};
type DirEntryCacheEntry = {
  mtimeMs: number;
  entries: CachedDirEntry[];
};
const DIR_ENTRY_CACHE = new Map<string, DirEntryCacheEntry>();

export function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isCode(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isMarkdown(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isSkillMarkdown(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === "skill.md";
}

function isNonSkillMarkdown(filePath: string): boolean {
  return isMarkdown(filePath) && !isSkillMarkdown(filePath);
}

function getCachedFileScanResult(params: {
  filePath: string;
  size: number;
  mtimeMs: number;
  maxFileBytes: number;
}): FileScanCacheEntry | undefined {
  const cached = FILE_SCAN_CACHE.get(params.filePath);
  if (!cached) {
    return undefined;
  }
  if (
    cached.size !== params.size ||
    cached.mtimeMs !== params.mtimeMs ||
    cached.maxFileBytes !== params.maxFileBytes
  ) {
    FILE_SCAN_CACHE.delete(params.filePath);
    return undefined;
  }
  return cached;
}

function setCachedFileScanResult(filePath: string, entry: FileScanCacheEntry): void {
  if (FILE_SCAN_CACHE.size >= FILE_SCAN_CACHE_MAX) {
    const oldest = FILE_SCAN_CACHE.keys().next();
    if (!oldest.done) {
      FILE_SCAN_CACHE.delete(oldest.value);
    }
  }
  FILE_SCAN_CACHE.set(filePath, entry);
}

function setCachedDirEntries(dirPath: string, entry: DirEntryCacheEntry): void {
  if (DIR_ENTRY_CACHE.size >= DIR_ENTRY_CACHE_MAX) {
    const oldest = DIR_ENTRY_CACHE.keys().next();
    if (!oldest.done) {
      DIR_ENTRY_CACHE.delete(oldest.value);
    }
  }
  DIR_ENTRY_CACHE.set(dirPath, entry);
}

export function clearSkillScanCacheForTest(): void {
  FILE_SCAN_CACHE.clear();
  DIR_ENTRY_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

type LineRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
  /** If set, the rule only fires when the *full source* also matches this pattern. */
  requiresContext?: RegExp;
};

type SourceRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  /** Primary pattern tested against the full source. */
  pattern?: RegExp;
  /** Custom matcher for rules that need lightweight parsing instead of a single regex. */
  match?: (params: {
    source: string;
    lines: string[];
  }) => { line: number; evidence: string } | null;
  /** Secondary context pattern; both must match for the rule to fire. */
  requiresContext?: RegExp;
  /** If set, secondary context must be within this many lines of the primary match. */
  requiresContextWindowLines?: number;
};

const LINE_RULES: LineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/,
  },
  {
    ruleId: "dynamic-code-execution",
    severity: "critical",
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    ruleId: "crypto-mining",
    severity: "critical",
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
  },
  {
    ruleId: "suspicious-network",
    severity: "warn",
    message: "WebSocket connection to non-standard port",
    pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/,
  },
];

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const NETWORK_SEND_CONTEXT_PATTERN = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;

const SOURCE_RULES: SourceRule[] = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Hex-encoded string sequence detected (possible obfuscation)",
    pattern: /(\\x[0-9a-fA-F]{2}){6,}/,
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Large base64 payload with decode call detected (possible obfuscation)",
    pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/,
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message:
      "Environment variable access combined with network send — possible credential harvesting",
    pattern: /process\.env/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
    requiresContextWindowLines: 8,
  },
];

// ---------------------------------------------------------------------------
// Markdown-specific rules (applied only to .md files)
// ---------------------------------------------------------------------------

/**
 * Unicode codepoints that are invisible or alter text rendering.
 * Used to hide malicious content from visual code review.
 */
const HIDDEN_UNICODE_RE =
  /\u{200B}|\u{200C}|\u{200D}|\u{200E}|\u{200F}|\u{202A}|\u{202B}|\u{202C}|\u{202D}|\u{202E}|\u{2028}|\u{2029}|\u{2060}|\u{2061}|\u{2062}|\u{2063}|\u{2064}|\u{2066}|\u{2067}|\u{2068}|\u{2069}|\u{206A}|\u{206B}|\u{206C}|\u{206D}|\u{206E}|\u{206F}|\u{FEFF}|\u{FFF9}|\u{FFFA}|\u{FFFB}/u;

const MARKDOWN_LINE_RULES: LineRule[] = [
  {
    ruleId: "hidden-unicode",
    severity: "warn",
    message: "Hidden Unicode characters detected (zero-width or text-direction override)",
    pattern: HIDDEN_UNICODE_RE,
  },
  {
    ruleId: "markdown-data-uri",
    severity: "warn",
    message: "Data URI with executable MIME type detected",
    pattern:
      /data:(?:text\/(?:html|javascript)|application\/(?:javascript|x-javascript|ecmascript))[;,]/i,
  },
];

const MARKDOWN_SOURCE_RULES: SourceRule[] = [
  {
    ruleId: "markdown-download-exec",
    severity: "critical",
    message: "Download-and-execute pattern detected in markdown content",
    match: findMarkdownDownloadExecMatch,
  },
  {
    ruleId: "markdown-encoded-payload",
    severity: "warn",
    message: "Large base64 block detected in markdown (possible obfuscated payload)",
    pattern: /```[^\n]*\n[A-Za-z0-9+/=\s]{400,}\n```/,
  },
  {
    ruleId: "markdown-hex-payload",
    severity: "warn",
    message: "Hex-encoded payload detected in markdown content",
    pattern: /(\\x[0-9a-fA-F]{2}){8,}/,
  },
];

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

function truncateEvidence(evidence: string, maxLen = 120): string {
  if (evidence.length <= maxLen) {
    return evidence;
  }
  return `${evidence.slice(0, maxLen)}…`;
}

function isBenignMemberExecMatch(line: string, match: RegExpExecArray): boolean {
  const command = match[1];
  if (command !== "exec") {
    return false;
  }

  const matchIndex = match.index;
  if (matchIndex <= 0 || line[matchIndex - 1] !== ".") {
    return false;
  }

  return !/\b(?:cp|childProcess|child_process)\s*\.\s*exec\s*\(/.test(line);
}

function stripCommentsForHeuristics(source: string): string {
  let stripped = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (quote) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      stripped += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      if (source[i] === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    stripped += ch;
  }

  return stripped;
}

function logicalMarkdownLines(lines: string[]): { line: number; text: string }[] {
  const logicalLines: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const startLine = index + 1;
    let text = lines[index] ?? "";
    while (/\\\s*$/.test(text) && index + 1 < lines.length) {
      text = `${text.replace(/\\\s*$/, " ")}${lines[index + 1] ?? ""}`;
      index += 1;
    }
    logicalLines.push({ line: startLine, text });
  }
  return logicalLines;
}

function stripMarkdownCommandPrefix(segment: string): string {
  let stripped = segment.trim();
  for (;;) {
    const next = stripped
      .replace(/^(?:[-*]\s+|\d+[.)]\s+|\$\s*|>\s*)/, "")
      .replace(/^(?:run|install|setup)\s*:\s*/i, "")
      .trim();
    if (next === stripped) {
      return stripped;
    }
    stripped = next;
  }
}

function splitShellPipeline(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  segments.push(current);
  return segments;
}

function tokenizeShellWords(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of segment.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isDownloaderToken(token: string): boolean {
  return /^(?:curl|wget)$/i.test(path.basename(token));
}

function isDownloadCommandSegment(segment: string): boolean {
  const tokens = tokenizeShellWords(stripMarkdownCommandPrefix(segment));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "sudo" || token === "doas") {
      while (tokens[index + 1]?.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (token === "env" || token === "/usr/bin/env") {
      while (
        tokens[index + 1]?.startsWith("-") ||
        isEnvironmentAssignment(tokens[index + 1] ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    return isDownloaderToken(token);
  }
  return false;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isInterpreterToken(token: string): boolean {
  const command = path.basename(token);
  return /^(?:sh|bash|zsh|fish|node(?:js)?|python(?:\d+(?:\.\d+)?)?|perl|ruby)(?:\d+(?:\.\d+)?)?$/i.test(
    command,
  );
}

function isExecutionSegment(segment: string): boolean {
  const tokens = tokenizeShellWords(segment);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "sudo" || token === "doas") {
      while (tokens[index + 1]?.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (token === "env" || token === "/usr/bin/env") {
      while (
        tokens[index + 1]?.startsWith("-") ||
        isEnvironmentAssignment(tokens[index + 1] ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    return isInterpreterToken(token);
  }
  return false;
}

function markdownCommandCandidates(line: string): string[] {
  const trimmed = line.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/`([^`\n]+)`/g)) {
    const inlineCommand = match[1]?.trim();
    if (inlineCommand) {
      candidates.push(inlineCommand);
    }
  }
  return candidates;
}

function isMarkdownTableSeparatorLine(line: string | undefined): boolean {
  const trimmed = line?.trim() ?? "";
  if (!trimmed.includes("|")) {
    return false;
  }
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(params: { lines: string[]; line: number; text: string }): boolean {
  const trimmed = params.text.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  if (trimmed.startsWith("|")) {
    return true;
  }
  return (
    isMarkdownTableSeparatorLine(params.lines[params.line - 2]) ||
    isMarkdownTableSeparatorLine(params.lines[params.line])
  );
}

function findMarkdownDownloadExecMatch(params: {
  lines: string[];
}): { line: number; evidence: string } | null {
  for (const logicalLine of logicalMarkdownLines(params.lines)) {
    const trimmed = logicalLine.text.trim();
    if (
      !trimmed ||
      isMarkdownTableRow({ lines: params.lines, line: logicalLine.line, text: logicalLine.text }) ||
      !/\b(?:curl|wget)\b/i.test(trimmed)
    ) {
      continue;
    }

    for (const candidate of markdownCommandCandidates(trimmed)) {
      const segments = splitShellPipeline(candidate);
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (
          isDownloadCommandSegment(segments[index] ?? "") &&
          isExecutionSegment(segments[index + 1] ?? "")
        ) {
          return { line: logicalLine.line, evidence: trimmed };
        }
      }
    }
  }
  return null;
}

function findSourceRuleMatch(params: {
  rule: SourceRule;
  source: string;
  lines: string[];
}): { line: number; evidence: string } | null {
  if (params.rule.match) {
    return params.rule.match({
      source: params.source,
      lines: params.lines,
    });
  }

  if (!params.rule.pattern) {
    return null;
  }
  if (!params.rule.pattern.test(params.source)) {
    return null;
  }
  if (params.rule.requiresContext && !params.rule.requiresContext.test(params.source)) {
    return null;
  }

  for (let i = 0; i < params.lines.length; i++) {
    if (!params.rule.pattern.test(params.lines[i] ?? "")) {
      continue;
    }

    if (params.rule.requiresContext && params.rule.requiresContextWindowLines !== undefined) {
      const start = Math.max(0, i - params.rule.requiresContextWindowLines);
      const end = Math.min(params.lines.length, i + params.rule.requiresContextWindowLines + 1);
      const windowSource = params.lines.slice(start, end).join("\n");
      if (!params.rule.requiresContext.test(windowSource)) {
        continue;
      }
    }

    return { line: i + 1, evidence: params.lines[i] ?? "" };
  }

  if (params.rule.requiresContextWindowLines !== undefined) {
    return null;
  }

  return { line: 1, evidence: params.source.slice(0, 120) };
}

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");
  const matchedLineRules = new Set<string>();
  const markdown = isMarkdown(filePath);

  const lineRules = markdown ? MARKDOWN_LINE_RULES : LINE_RULES;
  const sourceRules = markdown ? MARKDOWN_SOURCE_RULES : SOURCE_RULES;
  const sourceRuleSource = markdown ? source : heuristicSource;
  const sourceRuleLines = markdown ? lines : heuristicLines;

  // --- Line rules ---
  for (const rule of lineRules) {
    if (matchedLineRules.has(rule.ruleId)) {
      continue;
    }

    // Skip rule entirely if context requirement not met
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = rule.pattern.exec(line);
      if (!match) {
        continue;
      }

      if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(line, match)) {
        continue;
      }

      // Special handling for suspicious-network: check port
      if (rule.ruleId === "suspicious-network") {
        const port = Number.parseInt(match[1], 10);
        if (STANDARD_PORTS.has(port)) {
          continue;
        }
      }

      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: filePath,
        line: i + 1,
        message: rule.message,
        evidence: truncateEvidence(line.trim()),
      });
      matchedLineRules.add(rule.ruleId);
      break; // one finding per line-rule per file
    }
  }

  // --- Source rules ---
  const matchedSourceRules = new Set<string>();
  for (const rule of sourceRules) {
    // Allow multiple findings for different messages with the same ruleId
    // but deduplicate exact (ruleId+message) combos
    const ruleKey = `${rule.ruleId}::${rule.message}`;
    if (matchedSourceRules.has(ruleKey)) {
      continue;
    }

    const match = findSourceRuleMatch({
      rule,
      source: sourceRuleSource,
      lines: sourceRuleLines,
    });
    if (!match) {
      continue;
    }

    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: match.line,
      message: rule.message,
      evidence: truncateEvidence(lines[match.line - 1]?.trim() ?? match.evidence.trim()),
    });
    matchedSourceRules.add(ruleKey);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

function normalizeScanOptions(opts?: SkillScanOptions): Required<SkillScanOptions> {
  return {
    excludeTestFiles: opts?.excludeTestFiles ?? false,
    includeFiles: opts?.includeFiles ?? [],
    maxFiles: Math.max(1, opts?.maxFiles ?? DEFAULT_MAX_SCAN_FILES),
    maxFileBytes: Math.max(1, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
  };
}

function isExcludedTestDirectoryName(name: string): boolean {
  return TEST_DIRECTORY_NAMES.has(name);
}

function isExcludedTestFileName(name: string): boolean {
  return TEST_FILE_NAME_PATTERN.test(name);
}

async function walkDirMatchingLimit(
  dirPath: string,
  maxFiles: number,
  excludeTestFiles: boolean,
  includeFile: (fileName: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [dirPath];

  while (stack.length > 0 && files.length < maxFiles) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }

    const entries = await readDirEntriesWithCache(currentDir);
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (
        excludeTestFiles &&
        ((entry.kind === "dir" && isExcludedTestDirectoryName(entry.name)) ||
          (entry.kind === "file" && isExcludedTestFileName(entry.name)))
      ) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.kind === "dir") {
        stack.push(fullPath);
      } else if (entry.kind === "file" && includeFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function walkDirWithLimit(
  dirPath: string,
  maxFiles: number,
  excludeTestFiles: boolean,
): Promise<string[]> {
  const skillBudget = 1;
  const skillFiles = await walkDirMatchingLimit(
    dirPath,
    skillBudget,
    excludeTestFiles,
    isSkillMarkdown,
  );
  const codeFiles = await walkDirMatchingLimit(
    dirPath,
    maxFiles - skillFiles.length,
    excludeTestFiles,
    isCode,
  );
  const remainingFiles = maxFiles - codeFiles.length - skillFiles.length;
  if (remainingFiles <= 0) {
    return [...codeFiles, ...skillFiles];
  }

  const markdownFiles = await walkDirMatchingLimit(
    dirPath,
    remainingFiles,
    excludeTestFiles,
    isNonSkillMarkdown,
  );
  return [...codeFiles, ...skillFiles, ...markdownFiles];
}

async function readDirEntriesWithCache(dirPath: string): Promise<CachedDirEntry[]> {
  let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    st = await fs.stat(dirPath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  if (!st?.isDirectory()) {
    return [];
  }

  const cached = DIR_ENTRY_CACHE.get(dirPath);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return cached.entries;
  }

  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: CachedDirEntry[] = [];
  for (const entry of dirents) {
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: "dir" });
    } else if (entry.isFile()) {
      entries.push({ name: entry.name, kind: "file" });
    }
  }
  setCachedDirEntries(dirPath, {
    mtimeMs: st.mtimeMs,
    entries,
  });
  return entries;
}

async function resolveForcedFiles(params: {
  rootDir: string;
  includeFiles: string[];
}): Promise<string[]> {
  if (params.includeFiles.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawIncludePath of params.includeFiles) {
    const includePath = path.resolve(params.rootDir, rawIncludePath);
    if (!isPathInside(params.rootDir, includePath)) {
      continue;
    }
    if (!isScannable(includePath)) {
      continue;
    }
    if (seen.has(includePath)) {
      continue;
    }

    let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      st = await fs.stat(includePath);
    } catch (err) {
      if (hasErrnoCode(err, "ENOENT")) {
        continue;
      }
      throw err;
    }
    if (!st?.isFile()) {
      continue;
    }

    out.push(includePath);
    seen.add(includePath);
  }

  return out;
}

async function collectScannableFiles(dirPath: string, opts: Required<SkillScanOptions>) {
  const forcedFiles = await resolveForcedFiles({
    rootDir: dirPath,
    includeFiles: opts.includeFiles,
  });
  if (forcedFiles.length >= opts.maxFiles) {
    return forcedFiles.slice(0, opts.maxFiles);
  }

  const walkedFiles = await walkDirWithLimit(dirPath, opts.maxFiles, opts.excludeTestFiles);
  const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
  const out = [...forcedFiles];
  for (const walkedFile of walkedFiles) {
    if (out.length >= opts.maxFiles) {
      break;
    }
    const resolved = path.resolve(walkedFile);
    if (seen.has(resolved)) {
      continue;
    }
    out.push(walkedFile);
    seen.add(resolved);
  }
  return out;
}

async function scanFileWithCache(params: {
  filePath: string;
  maxFileBytes: number;
}): Promise<{ scanned: boolean; findings: SkillScanFinding[] }> {
  const { filePath, maxFileBytes } = params;
  let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    st = await fs.stat(filePath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return { scanned: false, findings: [] };
    }
    throw err;
  }
  if (!st?.isFile()) {
    return { scanned: false, findings: [] };
  }
  const cached = getCachedFileScanResult({
    filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    maxFileBytes,
  });
  if (cached) {
    return {
      scanned: cached.scanned,
      findings: cached.findings,
    };
  }

  if (st.size > maxFileBytes) {
    const skippedEntry: FileScanCacheEntry = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      maxFileBytes,
      scanned: false,
      findings: [],
    };
    setCachedFileScanResult(filePath, skippedEntry);
    return { scanned: false, findings: [] };
  }

  let source: string;
  try {
    source = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return { scanned: false, findings: [] };
    }
    throw err;
  }
  const findings = scanSource(source, filePath);
  setCachedFileScanResult(filePath, {
    size: st.size,
    mtimeMs: st.mtimeMs,
    maxFileBytes,
    scanned: true,
    findings,
  });
  return { scanned: true, findings };
}

export async function scanDirectory(
  dirPath: string,
  opts?: SkillScanOptions,
): Promise<SkillScanFinding[]> {
  const scanOptions = normalizeScanOptions(opts);
  const files = await collectScannableFiles(dirPath, scanOptions);
  const allFindings: SkillScanFinding[] = [];

  for (const file of files) {
    const scanResult = await scanFileWithCache({
      filePath: file,
      maxFileBytes: scanOptions.maxFileBytes,
    });
    if (!scanResult.scanned) {
      continue;
    }
    allFindings.push(...scanResult.findings);
  }

  return allFindings;
}

export async function scanDirectoryWithSummary(
  dirPath: string,
  opts?: SkillScanOptions,
): Promise<SkillScanSummary> {
  const scanOptions = normalizeScanOptions(opts);
  const files = await collectScannableFiles(dirPath, scanOptions);
  const allFindings: SkillScanFinding[] = [];
  let scannedFiles = 0;
  let critical = 0;
  let warn = 0;
  let info = 0;

  for (const file of files) {
    const scanResult = await scanFileWithCache({
      filePath: file,
      maxFileBytes: scanOptions.maxFileBytes,
    });
    if (!scanResult.scanned) {
      continue;
    }
    scannedFiles += 1;
    for (const finding of scanResult.findings) {
      allFindings.push(finding);
      if (finding.severity === "critical") {
        critical += 1;
      } else if (finding.severity === "warn") {
        warn += 1;
      } else {
        info += 1;
      }
    }
  }

  return {
    scannedFiles,
    critical,
    warn,
    info,
    findings: allFindings,
  };
}
