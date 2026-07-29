// Skill security scanner inspects skill files and manifests for unsafe patterns.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasErrnoCode } from "../../infra/errors.js";
import { isPathInside } from "../../security/scan-paths.js";
import { formatScanEvidence, LITERAL_SECRET_SKILL_CONTENT_RULE } from "./scan-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillScanSeverity = "info" | "warn" | "critical";

export type SkillScanFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  file: string;
  line: number;
  message: string;
  evidence: string;
};

type SkillScanSummary = {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  truncated: boolean;
  findings: SkillScanFinding[];
};

export type SkillScanOptions = {
  excludeTestFiles?: boolean;
  includeHiddenDirectories?: boolean;
  includeNestedNodeModulesTestFiles?: boolean;
  includeNodeModules?: boolean;
  includeFiles?: string[];
  onlyIncludeFiles?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
};

// ---------------------------------------------------------------------------
// Scannable extensions
// ---------------------------------------------------------------------------

const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
]);

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
type CollectedScannableFiles = {
  files: string[];
  truncated: boolean;
};
type DirEntryCacheEntry = {
  mtimeMs: number;
  entries: CachedDirEntry[];
};
const DIR_ENTRY_CACHE = new Map<string, DirEntryCacheEntry>();

export function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
  pattern: RegExp;
  /** Secondary context pattern; both must match for the rule to fire. */
  requiresContext?: RegExp;
  /** If set, secondary context must be within this many lines of the primary match. */
  requiresContextWindowLines?: number;
  /**
   * When set, evaluate this rule against a source with string-literal *contents*
   * blanked out (see `maskStringLiteralContents`), so it stops matching tokens that
   * only appear inside string data — e.g. `fetch(` in an `it()` description tripping
   * `env-harvesting`. Only safe for rules whose primary and context tokens never
   * legitimately live inside a string: `env-harvesting` matches `process.env` (dotted)
   * and `fetch(`/`.post(` calls, which are always code. Do NOT set it for a rule whose
   * token can be a bracket-property string (`potential-exfiltration`'s bare `readFile`
   * in `fs["readFile"]`) or a string payload (`obfuscated-code` hex/base64,
   * `crypto-mining` URLs) — masking would hide real matches. See #82469.
   */
  ignoreStringLiterals?: boolean;
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
    // Intentionally NOT ignoreStringLiterals: its primary token is a bare identifier
    // that legitimately appears as a bracket-property string in real reads such as
    // `fs["readFile"]`, so masking string contents would hide genuine exfiltration.
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
    ignoreStringLiterals: true,
  },
];

const SKILL_CONTENT_RULES: SourceRule[] = [
  LITERAL_SECRET_SKILL_CONTENT_RULE,
  {
    ruleId: "prompt-injection-ignore-instructions",
    severity: "critical",
    message: "Prompt-injection wording attempts to override higher-priority instructions",
    pattern: /ignore (all|any|previous|above|prior) instructions/i,
  },
  {
    ruleId: "prompt-injection-system",
    severity: "critical",
    message: "Skill text references hidden prompt layers",
    pattern: /\b(system prompt|developer message|hidden instructions)\b/i,
  },
  {
    ruleId: "prompt-injection-tool",
    severity: "critical",
    message: "Skill text encourages bypassing tool approval",
    pattern:
      /\b(run|execute|invoke|call)\b.{0,50}\btool\b.{0,50}\bwithout\b.{0,30}\b(permission|approval)/i,
  },
  {
    ruleId: "shell-pipe-to-shell",
    severity: "critical",
    message: "Skill text includes pipe-to-shell install pattern",
    pattern: /\b(curl|wget)\b[^|\n]{0,120}\|\s*(sh|bash|zsh)\b/i,
  },
  {
    ruleId: "secret-exfiltration",
    severity: "critical",
    message: "Skill text may exfiltrate environment variables",
    pattern: /\b(process\.env|env)\b.{0,80}\b(fetch|curl|wget|http|https)\b/i,
  },
  {
    ruleId: "destructive-delete",
    severity: "warn",
    message: "Skill text contains broad destructive delete command",
    pattern: /\brm\s+-rf\s+(\/|\$HOME|~|\.)/i,
  },
  {
    ruleId: "unsafe-permissions",
    severity: "warn",
    message: "Skill text contains unsafe permission change",
    pattern: /\bchmod\s+(-R\s+)?777\b/i,
  },
];

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

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

// Keywords after which a `/` begins a regex literal rather than a division, so the
// masker recognizes e.g. `return /["']/` as a regex and does not treat its quotes as
// a string start.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

// True when a `/` in code position starts a regex literal (expression position)
// rather than a division. Decided from the last meaningful char already emitted:
// operators/open-brackets/start-of-input allow a regex; a value end (identifier,
// `)`, `]`, `.`, a closed string) means division, unless the trailing word is a
// regex-preceding keyword. A heuristic, but enough to keep quotes inside regex
// literals from being mistaken for string starts (which would blank real code).
function regexLiteralAllowedAfter(code: string): boolean {
  let j = code.length - 1;
  while (j >= 0 && /\s/.test(code[j] ?? "")) {
    j--;
  }
  if (j < 0) {
    return true;
  }
  const c = code[j] ?? "";
  if ("([{,;:=!&|?+-*/%^~<>".includes(c)) {
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(code[k] ?? "")) {
      k--;
    }
    return REGEX_PRECEDING_KEYWORDS.has(code.slice(k + 1, j + 1));
  }
  return false;
}

// Scans a regex literal starting at `startIndex` (the opening `/`), returning its full
// text and the index of its last char, so callers can emit it verbatim as code.
// Handles `\` escapes and `[...]` classes (where `/` does not close); a newline ends an
// unterminated literal defensively.
function scanRegexLiteral(source: string, startIndex: number): { text: string; endIndex: number } {
  let text = source[startIndex] ?? "/";
  let inClass = false;
  let escaped = false;
  let i = startIndex + 1;
  for (; i < source.length; i++) {
    const ch = source[i] ?? "";
    text += ch;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    } else if (ch === "\n" || (ch === "/" && !inClass)) {
      break;
    }
  }
  return { text, endIndex: Math.min(i, source.length - 1) };
}

/**
 * Blanks the *contents* of string literals in already comment-free source, so
 * rules that hunt for code constructs (a real `fetch(` call, `process.env` access)
 * stop matching those same tokens when they only appear inside string data — e.g.
 * `fetch(` in an `it()` description. Quote delimiters, newlines, and length are
 * preserved so reported line/offset stay aligned with the raw source.
 *
 * Backtick templates keep their `${...}` interpolation bodies (they hold real code
 * that must still be scanned); only the static template text is blanked. Nested
 * strings inside an interpolation are tracked so a brace inside `obj["}"]` cannot
 * miscount the interpolation boundary. Regex literals in code position are consumed
 * as code so quote chars inside them (e.g. `/["']/`) are not mistaken for a string
 * start. Input must already be comment-free (run `stripCommentsForHeuristics` first)
 * so `/` is always a division or regex literal, never a comment. See #82469.
 */
function maskStringLiteralContents(source: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  // >0 while inside a `${...}` interpolation; counts brace nesting to find its close.
  let exprDepth = 0;
  // A string opened *inside* an interpolation, so its braces do not move exprDepth.
  let exprQuote: "'" | '"' | "`" | null = null;
  let exprEscaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (quote === null) {
      // A regex literal in code position: consume it as code so quote chars inside
      // it (e.g. `/["']/`) are not mistaken for a string start, which would blank
      // real code that follows and weaken env/exfil detection.
      if (ch === "/" && regexLiteralAllowedAfter(out)) {
        const regexLiteral = scanRegexLiteral(source, i);
        out += regexLiteral.text;
        i = regexLiteral.endIndex;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      }
      out += ch;
      continue;
    }

    // Single/double-quoted string: blank every content char, keep the closing delimiter.
    if (quote !== "`") {
      if (escaped) {
        out += ch === "\n" ? "\n" : " ";
        escaped = false;
      } else if (ch === "\\") {
        out += " ";
        escaped = true;
      } else if (ch === quote) {
        out += ch;
        quote = null;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    // Inside a `${...}` interpolation of a backtick template: preserve as code.
    if (exprDepth > 0) {
      // Consume regex literals here too, so a `}` inside `/}/ ` does not prematurely
      // end the preserved interpolation and blank real code that follows.
      if (exprQuote === null && ch === "/" && regexLiteralAllowedAfter(out)) {
        const regexLiteral = scanRegexLiteral(source, i);
        out += regexLiteral.text;
        i = regexLiteral.endIndex;
        continue;
      }
      // A single/double-quoted string inside the interpolation: blank its contents
      // like a top-level string, so a `fetch(` buried in it is not scanned as context.
      // (A nested backtick template is preserved as code; fully masking its own nested
      // `${...}` would require a recursive lexer — left as documented scope.)
      if (exprQuote === "'" || exprQuote === '"') {
        if (exprEscaped) {
          out += ch === "\n" ? "\n" : " ";
          exprEscaped = false;
        } else if (ch === "\\") {
          out += " ";
          exprEscaped = true;
        } else if (ch === exprQuote) {
          out += ch;
          exprQuote = null;
        } else {
          out += ch === "\n" ? "\n" : " ";
        }
        continue;
      }
      out += ch;
      if (exprQuote === "`") {
        if (exprEscaped) {
          exprEscaped = false;
        } else if (ch === "\\") {
          exprEscaped = true;
        } else if (ch === exprQuote) {
          exprQuote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === "`") {
        exprQuote = ch;
      } else if (ch === "{") {
        exprDepth++;
      } else if (ch === "}") {
        exprDepth--;
      }
      continue;
    }

    // Static backtick text: blank it, but enter interpolations and honor the close.
    if (escaped) {
      out += ch === "\n" ? "\n" : " ";
      escaped = false;
    } else if (ch === "\\") {
      out += " ";
      escaped = true;
    } else if (ch === "$" && next === "{") {
      out += "${";
      i++;
      exprDepth = 1;
    } else if (ch === "`") {
      out += ch;
      quote = null;
    } else {
      out += ch === "\n" ? "\n" : " ";
    }
  }

  return out;
}

function findSourceRuleMatch(params: {
  rule: SourceRule;
  source: string;
  lines: string[];
}): { line: number; evidence: string } | null {
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

  return { line: 1, evidence: truncateUtf16Safe(params.source, 120) };
}

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");
  // Same source with string-literal contents blanked, for rules that hunt for code
  // constructs and should ignore tokens that only appear inside string data (#82469).
  const stringMaskedSource = maskStringLiteralContents(heuristicSource);
  const stringMaskedLines = stringMaskedSource.split("\n");
  const matchedLineRules = new Set<string>();

  // --- Line rules ---
  for (const rule of LINE_RULES) {
    if (matchedLineRules.has(rule.ruleId)) {
      continue;
    }

    // Skip rule entirely if context requirement not met
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    for (const [i, line] of lines.entries()) {
      const match = rule.pattern.exec(line);
      if (!match) {
        continue;
      }

      if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(line, match)) {
        continue;
      }

      // Special handling for suspicious-network: check port
      if (rule.ruleId === "suspicious-network") {
        const port = Number.parseInt(expectDefined(match[1], "scanner regex capture 1"), 10);
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
        evidence: formatScanEvidence(line),
      });
      matchedLineRules.add(rule.ruleId);
      break; // one finding per line-rule per file
    }
  }

  // --- Source rules ---
  const matchedSourceRules = new Set<string>();
  for (const rule of SOURCE_RULES) {
    // Allow multiple findings for different messages with the same ruleId
    // but deduplicate exact (ruleId+message) combos
    const ruleKey = `${rule.ruleId}::${rule.message}`;
    if (matchedSourceRules.has(ruleKey)) {
      continue;
    }

    const match = findSourceRuleMatch({
      rule,
      source: rule.ignoreStringLiterals ? stringMaskedSource : heuristicSource,
      lines: rule.ignoreStringLiterals ? stringMaskedLines : heuristicLines,
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
      evidence: formatScanEvidence(lines[match.line - 1] ?? match.evidence),
    });
    matchedSourceRules.add(ruleKey);
  }

  return findings;
}

export function scanSkillContent(content: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = content.split("\n");
  const matchedRules = new Set<string>();

  for (const rule of SKILL_CONTENT_RULES) {
    if (matchedRules.has(rule.ruleId)) {
      continue;
    }
    const match = findSourceRuleMatch({
      rule,
      source: content,
      lines,
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
      // Scanner output is user-visible; redact the whole evidence line if any rule sees a key.
      evidence:
        rule.ruleId === "literal-secret"
          ? "[REDACTED CREDENTIAL]"
          : formatScanEvidence(lines[match.line - 1] ?? match.evidence),
    });
    matchedRules.add(rule.ruleId);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

function normalizeScanOptions(opts?: SkillScanOptions): Required<SkillScanOptions> {
  return {
    excludeTestFiles: opts?.excludeTestFiles ?? false,
    includeHiddenDirectories: opts?.includeHiddenDirectories ?? false,
    includeNestedNodeModulesTestFiles: opts?.includeNestedNodeModulesTestFiles ?? false,
    includeNodeModules: opts?.includeNodeModules ?? false,
    includeFiles: opts?.includeFiles ?? [],
    onlyIncludeFiles: opts?.onlyIncludeFiles ?? false,
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

function pathContainsNodeModulesSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/u).includes("node_modules");
}

async function walkDirWithLimit(
  rootDir: string,
  dirPath: string,
  candidateLimit: number,
  excludeTestFiles: boolean,
  includeHiddenDirectories: boolean,
  includeNestedNodeModulesTestFiles: boolean,
  includeNodeModules: boolean,
): Promise<CollectedScannableFiles> {
  const files: string[] = [];
  const stack: string[] = [dirPath];

  while (stack.length > 0 && files.length < candidateLimit) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }

    const entries = await readDirEntriesWithCache(currentDir);
    for (const entry of entries) {
      if (files.length >= candidateLimit) {
        break;
      }
      if (
        (!includeHiddenDirectories && entry.name.startsWith(".")) ||
        (!includeNodeModules && entry.name === "node_modules")
      ) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const isExcludedTestPath =
        entry.kind === "dir"
          ? isExcludedTestDirectoryName(entry.name)
          : isExcludedTestFileName(entry.name);
      if (
        excludeTestFiles &&
        isExcludedTestPath &&
        !(
          includeNestedNodeModulesTestFiles &&
          pathContainsNodeModulesSegment(path.relative(rootDir, fullPath))
        )
      ) {
        continue;
      }
      if (entry.kind === "dir") {
        stack.push(fullPath);
      } else if (entry.kind === "file" && isScannable(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return { files, truncated: files.length >= candidateLimit };
}

async function readDirEntriesWithCache(dirPath: string): Promise<CachedDirEntry[]> {
  let st: Awaited<ReturnType<typeof fs.stat>> | null;
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

    let st: Awaited<ReturnType<typeof fs.stat>> | null;
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

async function collectScannableFiles(
  dirPath: string,
  opts: Required<SkillScanOptions>,
): Promise<CollectedScannableFiles> {
  const forcedFiles = await resolveForcedFiles({
    rootDir: dirPath,
    includeFiles: opts.includeFiles,
  });
  if (opts.onlyIncludeFiles) {
    return {
      files: forcedFiles.slice(0, opts.maxFiles),
      truncated: forcedFiles.length > opts.maxFiles,
    };
  }
  if (forcedFiles.length > opts.maxFiles) {
    return { files: forcedFiles.slice(0, opts.maxFiles), truncated: true };
  }

  const walked = await walkDirWithLimit(
    dirPath,
    dirPath,
    opts.maxFiles + 1,
    opts.excludeTestFiles,
    opts.includeHiddenDirectories,
    opts.includeNestedNodeModulesTestFiles,
    opts.includeNodeModules,
  );
  const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
  const out = [...forcedFiles];
  for (const walkedFile of walked.files) {
    const resolved = path.resolve(walkedFile);
    if (seen.has(resolved)) {
      continue;
    }
    if (out.length >= opts.maxFiles) {
      return { files: out.slice(0, opts.maxFiles), truncated: true };
    }
    out.push(walkedFile);
    seen.add(resolved);
  }
  return { files: out, truncated: false };
}

async function scanFileWithCache(params: {
  filePath: string;
  maxFileBytes: number;
}): Promise<{ scanned: boolean; findings: SkillScanFinding[] }> {
  const { filePath, maxFileBytes } = params;
  let st: Awaited<ReturnType<typeof fs.stat>> | null;
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

export async function scanDirectoryWithSummary(
  dirPath: string,
  opts?: SkillScanOptions,
): Promise<SkillScanSummary> {
  const scanOptions = normalizeScanOptions(opts);
  const { files, truncated } = await collectScannableFiles(dirPath, scanOptions);
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
    truncated,
    findings: allFindings,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
