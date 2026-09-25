import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasErrnoCode } from "../../infra/errors.js";
import { FsSafeError, readLocalFileSafely } from "../../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isPathInside } from "../../security/scan-paths.js";
import { escapeRegExp } from "../../shared/regexp.js";
import { formatScanEvidence, LITERAL_SECRET_SKILL_CONTENT_RULE } from "./scan-evidence.js";

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
const MAX_LINE_RULE_FINDINGS_PER_RULE = 32;
const FILE_SCAN_CACHE_MAX = 5000;
const MAX_SCAN_DIRECTORY_ENTRIES = 100_000;
const TEST_DIRECTORY_NAMES = new Set(["__fixtures__", "__mocks__", "__tests__", "test", "tests"]);
const TEST_FILE_NAME_PATTERN = /\.(?:mock|spec|test|test-helper|test-support)\.[^.]+$/i;

type FileScanIdentity = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;

type FileScanCacheEntry = {
  identity: FileScanIdentity;
  maxFileBytes: number;
  scanned: boolean;
  findings: SkillScanFinding[];
};

const FILE_SCAN_CACHE = new Map<string, FileScanCacheEntry>();
type CollectedScannableFiles = {
  files: string[];
  truncated: boolean;
};

export function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getCachedFileScanResult(params: {
  filePath: string;
  identity: FileScanIdentity;
  maxFileBytes: number;
}): FileScanCacheEntry | undefined {
  const cached = FILE_SCAN_CACHE.get(params.filePath);
  if (!cached) {
    return undefined;
  }
  if (
    !sameFileScanIdentity(cached.identity, params.identity) ||
    cached.maxFileBytes !== params.maxFileBytes
  ) {
    FILE_SCAN_CACHE.delete(params.filePath);
    return undefined;
  }
  return cached;
}

function fileScanIdentity({ dev, ino, size, mtimeMs, ctimeMs }: Stats): FileScanIdentity {
  return { dev, ino, size, mtimeMs, ctimeMs };
}

function sameFileScanIdentity(left: FileScanIdentity, right: FileScanIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function setCachedFileScanResult(filePath: string, entry: FileScanCacheEntry): void {
  pruneMapToMaxSize(FILE_SCAN_CACHE, FILE_SCAN_CACHE_MAX - 1);
  FILE_SCAN_CACHE.set(filePath, entry);
}

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
};

const LINE_RULES: LineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    // Capture the method in group 1 for direct calls and group 2 for computed calls.
    pattern:
      /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(|["'](exec|execSync|spawn|spawnSync|execFile|execFileSync)["']\s*\]\s*\(/,
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

const SKILL_CONTENT_RULES: SourceRule[] = [
  LITERAL_SECRET_SKILL_CONTENT_RULE,
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

const CHILD_PROCESS_EXEC_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

type ChildProcessBindings = {
  methodAliases: Set<string>;
  namespaceAliases: Set<string>;
};

// Only imports/requires establish provenance; unrelated aliases must not match.
function collectChildProcessBindings(source: string): ChildProcessBindings {
  const methodAliases = new Set<string>();
  const namespaceAliases = new Set<string>();

  // ESM named imports: import { spawn as launch, execFile } from "child_process"
  const esmNamed = /\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  // ESM default namespace: import cp from "child_process"
  const esmDefault = /\bimport\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g;
  // ESM namespace import: import * as proc from "child_process"
  const esmNamespace = /\bimport\s*\*\s*as\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g;
  // CJS destructured: const { exec: run, spawn } = require("child_process")
  const cjsDestructured =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
  // CJS namespace: const proc = require("child_process")
  const cjsNamespace =
    /\b(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;

  const collectSpecifiers = (specText: string): void => {
    for (const rawSpec of specText.split(",")) {
      const spec = rawSpec.trim();
      if (!spec) {
        continue;
      }
      // Renamed binding: `spawn as launch` (ESM) or `exec: run` (CJS)
      const asMatch = spec.match(/^(\w+)\s+(?:as)\s+(\w+)$/) ?? spec.match(/^(\w+)\s*:\s*(\w+)$/);
      if (asMatch?.[1] && asMatch[2]) {
        const original = asMatch[1];
        const alias = asMatch[2];
        if (CHILD_PROCESS_EXEC_METHODS.has(original)) {
          methodAliases.add(alias);
        }
      }
      // Bare imported method name (`execFile`) is already matched by the
      // literal pattern, so no alias entry is needed for it.
    }
  };

  let match: RegExpExecArray | null;
  while ((match = esmNamed.exec(source))) {
    collectSpecifiers(expectDefined(match[1], "child_process esm named import specifiers"));
  }
  while ((match = cjsDestructured.exec(source))) {
    collectSpecifiers(expectDefined(match[1], "child_process cjs destructured specifiers"));
  }
  while ((match = esmDefault.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process esm default namespace"));
  }
  while ((match = esmNamespace.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process esm namespace import"));
  }
  while ((match = cjsNamespace.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process cjs namespace"));
  }

  return { methodAliases, namespaceAliases };
}

// Report every standalone alias call in source order, excluding object members.
function matchAliasedChildProcessCalls(line: string, methodAliases: Set<string>): number[] {
  const calls: number[] = [];
  for (const alias of methodAliases) {
    const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(alias)}\\s*\\(`, "g");
    for (const callMatch of line.matchAll(pattern)) {
      calls.push(callMatch.index);
    }
  }
  return calls.toSorted((a, b) => a - b);
}

// Retain the conventional child_process names alongside proven namespace aliases.
const LITERAL_NAMESPACE_RECEIVERS = new Set(["cp", "childProcess", "child_process"]);

function isBenignMemberExecMatch(
  line: string,
  match: RegExpExecArray,
  namespaceAliases: Set<string>,
): boolean {
  // group 1 = direct call command, group 2 = computed-member command.
  const command = match[1] ?? match[2];
  if (!command) {
    return false;
  }

  const matchIndex = match.index;
  const charAtMatch = line[matchIndex];
  // Computed calls require a known receiver for every watched method.
  if (charAtMatch === '"' || charAtMatch === "'") {
    const receiverMatch = line.slice(0, matchIndex).match(/(\w+)\s*\[\s*$/);
    const receiver = receiverMatch?.[1];
    return (
      !receiver || (!namespaceAliases.has(receiver) && !LITERAL_NAMESPACE_RECEIVERS.has(receiver))
    );
  }

  // Only .exec requires a known receiver; this excludes RegExp.exec.
  if (command === "exec" && matchIndex > 0 && line[matchIndex - 1] === ".") {
    const receiverMatch = line.slice(0, matchIndex - 1).match(/(\w+)\s*$/);
    const receiver = receiverMatch?.[1];
    return (
      !receiver || (!namespaceAliases.has(receiver) && !LITERAL_NAMESPACE_RECEIVERS.has(receiver))
    );
  }

  return false;
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

function findSourceRuleMatch(params: {
  rule: SourceRule;
  source: string;
  lines: string[];
}): { line: number; evidence: string } | null {
  const sourceMatch = params.rule.pattern.exec(params.source);
  if (!sourceMatch) {
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

  // Multiline rules cannot match any one line. Preserve the actual match start
  // so stored findings point at the dangerous text instead of file metadata.
  let line = 1;
  for (let i = 0; i < sourceMatch.index; i++) {
    if (params.source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return { line, evidence: params.lines[line - 1] ?? truncateUtf16Safe(params.source, 120) };
}

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");

  const { methodAliases, namespaceAliases } = collectChildProcessBindings(heuristicSource);

  for (const rule of LINE_RULES) {
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    let acceptedMatches = 0;
    let omittedMatches = 0;
    let lastOmittedLine: number | undefined;
    const addFinding = (line: string, lineNumber: number): boolean => {
      if (acceptedMatches >= MAX_LINE_RULE_FINDINGS_PER_RULE) {
        omittedMatches += 1;
        lastOmittedLine = lineNumber;
        return false;
      }
      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: filePath,
        line: lineNumber,
        message: rule.message,
        evidence: formatScanEvidence(line),
      });
      acceptedMatches += 1;
      return true;
    };
    for (const [i, line] of lines.entries()) {
      const matches = line.matchAll(
        new RegExp(
          rule.pattern.source,
          rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
        ),
      );
      const literalDangerousExecIndexes = new Set<number>();
      for (const match of matches) {
        if (
          rule.ruleId === "dangerous-exec" &&
          isBenignMemberExecMatch(line, match, namespaceAliases)
        ) {
          continue;
        }

        if (rule.ruleId === "suspicious-network") {
          const port = Number.parseInt(expectDefined(match[1], "scanner regex capture 1"), 10);
          if (STANDARD_PORTS.has(port)) {
            continue;
          }
        }

        if (addFinding(line, i + 1) && rule.ruleId === "dangerous-exec") {
          literalDangerousExecIndexes.add(match.index);
        }
      }

      // Aliases follow literal matches; don't emit a call twice if both patterns match.
      if (rule.ruleId === "dangerous-exec" && methodAliases.size > 0) {
        for (const index of matchAliasedChildProcessCalls(line, methodAliases)) {
          if (literalDangerousExecIndexes.has(index)) {
            continue;
          }
          addFinding(line, i + 1);
        }
      }
    }
    if (lastOmittedLine !== undefined) {
      findings.push({
        ruleId: `${rule.ruleId}-truncated`,
        severity: rule.severity,
        file: filePath,
        line: lastOmittedLine,
        message: `${omittedMatches} additional ${rule.ruleId} matches omitted after ${MAX_LINE_RULE_FINDINGS_PER_RULE} findings`,
        evidence: `[${omittedMatches} additional matches omitted after ${MAX_LINE_RULE_FINDINGS_PER_RULE} findings]`,
      });
    }
  }

  for (const rule of SOURCE_RULES) {
    const match = findSourceRuleMatch({
      rule,
      source: heuristicSource,
      lines: heuristicLines,
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
  }

  return findings;
}

export function scanSkillContent(content: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = content.split("\n");

  for (const rule of SKILL_CONTENT_RULES) {
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
  }

  return findings;
}

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

async function statIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

async function resolveForcedFiles(params: {
  rootDir: string;
  includeFiles: string[];
}): Promise<string[]> {
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

    const st = await statIfPresent(includePath);
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

  const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
  const files = [...forcedFiles];
  const include = ({ name, kind, relativePath }: WalkDirectoryEntry) =>
    (opts.includeHiddenDirectories || !name.startsWith(".")) &&
    (opts.includeNodeModules || name !== "node_modules") &&
    (!opts.excludeTestFiles ||
      !(kind === "directory"
        ? TEST_DIRECTORY_NAMES.has(name)
        : TEST_FILE_NAME_PATTERN.test(name)) ||
      (opts.includeNestedNodeModulesTestFiles &&
        relativePath.split(/[\\/]+/u).includes("node_modules")));
  const walked = await walkDirectory(dirPath, {
    maxEntries: Math.max(
      MAX_SCAN_DIRECTORY_ENTRIES,
      Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(opts.maxFiles) * 100),
    ),
    symlinks: "skip",
    include: (entry) => {
      if (
        files.length <= opts.maxFiles &&
        entry.kind === "file" &&
        isScannable(entry.name) &&
        include(entry) &&
        !seen.has(entry.path)
      ) {
        seen.add(entry.path);
        files.push(entry.path);
      }
      return false;
    },
    descend: (entry) => files.length <= opts.maxFiles && include(entry),
  });
  for (const { error } of walked.failedDirs) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return {
    files: files.slice(0, opts.maxFiles),
    truncated: walked.truncated || files.length > opts.maxFiles,
  };
}

async function scanFileWithCache(params: {
  filePath: string;
  maxFileBytes: number;
}): Promise<{ scanned: boolean; findings: SkillScanFinding[] }> {
  const { filePath, maxFileBytes } = params;
  const st = await statIfPresent(filePath);
  if (!st?.isFile()) {
    return { scanned: false, findings: [] };
  }
  const cached = getCachedFileScanResult({
    filePath,
    identity: st,
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
      identity: fileScanIdentity(st),
      maxFileBytes,
      scanned: false,
      findings: [],
    };
    setCachedFileScanResult(filePath, skippedEntry);
    return { scanned: false, findings: [] };
  }

  try {
    // Explicitly included entrypoints may be symlinked outside the scan directory.
    const { buffer, stat } = await readLocalFileSafely({
      filePath: await fs.realpath(filePath),
      maxBytes: maxFileBytes,
    });
    const findings = scanSource(buffer.toString("utf8"), filePath);
    setCachedFileScanResult(filePath, {
      identity: fileScanIdentity(stat),
      maxFileBytes,
      scanned: true,
      findings,
    });
    return { scanned: true, findings };
  } catch (err) {
    if (
      hasErrnoCode(err, "ENOENT") ||
      (err instanceof FsSafeError &&
        (err.code === "not-found" || err.code === "not-file" || err.code === "too-large"))
    ) {
      return { scanned: false, findings: [] };
    }
    throw err;
  }
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
