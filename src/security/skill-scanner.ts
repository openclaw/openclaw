import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";

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
  includeFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
};

// ---------------------------------------------------------------------------
// Scannable extensions
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".mts", ".cts", ".jsx", ".tsx"]);

/** Extensions scanned for invisible Unicode only (no code rules). */
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".yaml", ".yml", ".json"]);

const DEFAULT_MAX_SCAN_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export function isScannable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
};

// ---------------------------------------------------------------------------
// Unicode safety helpers
// ---------------------------------------------------------------------------

type InvisibleUnicodeFileSummary = {
  renderedEvidence: string;
  evidenceLine: number;
  uniqueCodePoints: string[];
  total: number;
  tags: number;
  variationSelectors: number;
  bidi: number;
  other: number;
  longestConsecutiveRun: number;
  severity: SkillScanSeverity;
};

const INVISIBLE_UNICODE_PATTERN =
  /[\u061C\u200B\u200C\u200D\u200E\u200F\u2060\u202A-\u202E\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

function isInvisibleUnicodeCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isBidiControlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function formatUnicodeCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase();
  const padded = hex.padStart(4, "0");
  return `U+${padded}`;
}

function isTagCodePoint(codePoint: number): boolean {
  return codePoint >= 0xe0000 && codePoint <= 0xe007f;
}

function isVariationSelectorCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function describeInvisibleUnicodeCodePoint(codePoint: number): string {
  switch (codePoint) {
    case 0x061c:
      return `${formatUnicodeCodePoint(codePoint)} ARABIC LETTER MARK`;
    case 0x200b:
      return `${formatUnicodeCodePoint(codePoint)} ZERO WIDTH SPACE`;
    case 0x200c:
      return `${formatUnicodeCodePoint(codePoint)} ZERO WIDTH NON-JOINER`;
    case 0x200d:
      return `${formatUnicodeCodePoint(codePoint)} ZERO WIDTH JOINER`;
    case 0x200e:
      return `${formatUnicodeCodePoint(codePoint)} LEFT-TO-RIGHT MARK`;
    case 0x200f:
      return `${formatUnicodeCodePoint(codePoint)} RIGHT-TO-LEFT MARK`;
    case 0x202a:
      return `${formatUnicodeCodePoint(codePoint)} LEFT-TO-RIGHT EMBEDDING`;
    case 0x202b:
      return `${formatUnicodeCodePoint(codePoint)} RIGHT-TO-LEFT EMBEDDING`;
    case 0x202c:
      return `${formatUnicodeCodePoint(codePoint)} POP DIRECTIONAL FORMATTING`;
    case 0x202d:
      return `${formatUnicodeCodePoint(codePoint)} LEFT-TO-RIGHT OVERRIDE`;
    case 0x202e:
      return `${formatUnicodeCodePoint(codePoint)} RIGHT-TO-LEFT OVERRIDE`;
    case 0x2060:
      return `${formatUnicodeCodePoint(codePoint)} WORD JOINER`;
    case 0x2066:
      return `${formatUnicodeCodePoint(codePoint)} LEFT-TO-RIGHT ISOLATE`;
    case 0x2067:
      return `${formatUnicodeCodePoint(codePoint)} RIGHT-TO-LEFT ISOLATE`;
    case 0x2068:
      return `${formatUnicodeCodePoint(codePoint)} FIRST STRONG ISOLATE`;
    case 0x2069:
      return `${formatUnicodeCodePoint(codePoint)} POP DIRECTIONAL ISOLATE`;
    case 0xfeff:
      return `${formatUnicodeCodePoint(codePoint)} ZERO WIDTH NO-BREAK SPACE (BOM)`;
    default: {
      if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) {
        return `${formatUnicodeCodePoint(codePoint)} VARIATION SELECTOR`;
      }
      if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) {
        return `${formatUnicodeCodePoint(codePoint)} VARIATION SELECTOR (SUPPLEMENT)`;
      }
      if (codePoint >= 0xe0000 && codePoint <= 0xe007f) {
        return `${formatUnicodeCodePoint(codePoint)} TAG CHARACTER`;
      }
      return formatUnicodeCodePoint(codePoint);
    }
  }
}

function scanInvisibleUnicodeInFile(source: string): InvisibleUnicodeFileSummary | null {
  if (!INVISIBLE_UNICODE_PATTERN.test(source)) {
    return null;
  }

  const unique = new Map<number, string>();
  const lines = source.split("\n");
  let evidenceLine = 0;
  let renderedEvidence = "";

  let total = 0;
  let tags = 0;
  let variationSelectors = 0;
  let bidi = 0;
  let other = 0;
  let longestConsecutiveRun = 0;
  let currentRun = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\r$/, "");
    if (!INVISIBLE_UNICODE_PATTERN.test(line)) {
      currentRun = 0;
      continue;
    }

    const parts: string[] = [];
    for (const ch of line) {
      const codePoint = ch.codePointAt(0);
      if (codePoint === undefined || !isInvisibleUnicodeCodePoint(codePoint)) {
        if (currentRun > longestConsecutiveRun) {
          longestConsecutiveRun = currentRun;
        }
        currentRun = 0;
        parts.push(ch);
        continue;
      }

      total += 1;
      currentRun += 1;
      if (isBidiControlCodePoint(codePoint)) {
        bidi += 1;
      } else if (isTagCodePoint(codePoint)) {
        tags += 1;
      } else if (isVariationSelectorCodePoint(codePoint)) {
        variationSelectors += 1;
      } else {
        other += 1;
      }

      if (!unique.has(codePoint)) {
        unique.set(codePoint, describeInvisibleUnicodeCodePoint(codePoint));
      }

      if (evidenceLine === 0) {
        parts.push(`<${unique.get(codePoint) ?? formatUnicodeCodePoint(codePoint)}>`);
      }
    }

    if (currentRun > longestConsecutiveRun) {
      longestConsecutiveRun = currentRun;
    }
    currentRun = 0;

    if (evidenceLine === 0) {
      evidenceLine = lineIndex + 1;
      renderedEvidence = parts.length > 0 ? parts.join("") : line;
    }
  }

  if (total === 0) {
    return null;
  }

  const severity: SkillScanSeverity = "warn";

  return {
    renderedEvidence,
    evidenceLine: evidenceLine || 1,
    uniqueCodePoints: [...unique.values()],
    total,
    tags,
    variationSelectors,
    bidi,
    other,
    longestConsecutiveRun,
    severity,
  };
}

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
  {
    ruleId: "invisible-unicode",
    severity: "warn",
    message:
      "Invisible Unicode formatting/tag characters detected (possible obfuscation or Trojan Source)",
    pattern: INVISIBLE_UNICODE_PATTERN,
  },
];

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);

const SOURCE_RULES: SourceRule[] = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
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
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
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

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const matchedLineRules = new Set<string>();

  const codeFile = isCodeFile(filePath);

  // --- Line rules ---
  for (const rule of LINE_RULES) {
    if (matchedLineRules.has(rule.ruleId)) {
      continue;
    }

    // Non-code files (e.g. .md) only get the invisible-unicode check
    if (!codeFile && rule.ruleId !== "invisible-unicode") {
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

      // Special handling for suspicious-network: check port
      if (rule.ruleId === "suspicious-network") {
        const port = parseInt(match[1], 10);
        if (STANDARD_PORTS.has(port)) {
          continue;
        }
      }

      if (rule.ruleId === "invisible-unicode") {
        const summary = scanInvisibleUnicodeInFile(source);
        if (!summary) {
          continue;
        }

        // Skip files with only isolated invisible chars (e.g. emoji variation
        // selectors). Report only when there are 10+ consecutive invisible
        // code points (likely ASCII smuggling / hidden prompt injection) or
        // any bidi controls (Trojan Source risk even in small numbers).
        if (summary.longestConsecutiveRun < 10 && summary.bidi === 0) {
          continue;
        }
        const uniqueList =
          summary.uniqueCodePoints.length > 4
            ? `${summary.uniqueCodePoints.slice(0, 4).join(", ")} (+${
                summary.uniqueCodePoints.length - 4
              } more)`
            : summary.uniqueCodePoints.join(", ");

        const parts: string[] = [
          `${summary.total} invisible char(s)`,
          `longest consecutive run: ${summary.longestConsecutiveRun}`,
        ];
        if (summary.tags > 0) {
          parts.push(`tags=${summary.tags}`);
        }
        if (summary.variationSelectors > 0) {
          parts.push(`vs=${summary.variationSelectors}`);
        }
        if (summary.bidi > 0) {
          parts.push(`bidi=${summary.bidi}`);
        }
        parts.push(uniqueList);

        const hint =
          summary.longestConsecutiveRun >= 10
            ? " — long consecutive sequences are suspicious and may indicate ASCII smuggling or hidden prompt injection"
            : " — bidi controls can flip displayed code direction (Trojan Source risk)";

        findings.push({
          ruleId: rule.ruleId,
          severity: summary.severity,
          file: filePath,
          line: summary.evidenceLine,
          message: `${rule.message} (${parts.join("; ")}${hint})`,
          evidence: truncateEvidence(summary.renderedEvidence),
        });
        matchedLineRules.add(rule.ruleId);
        break; // one finding per line-rule per file
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

  // --- Source rules (code files only) ---
  if (!codeFile) {
    return findings;
  }
  const matchedSourceRules = new Set<string>();
  for (const rule of SOURCE_RULES) {
    // Allow multiple findings for different messages with the same ruleId
    // but deduplicate exact (ruleId+message) combos
    const ruleKey = `${rule.ruleId}::${rule.message}`;
    if (matchedSourceRules.has(ruleKey)) {
      continue;
    }

    if (!rule.pattern.test(source)) {
      continue;
    }
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    // Find the first matching line for evidence + line number
    let matchLine = 0;
    let matchEvidence = "";
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        matchLine = i + 1;
        matchEvidence = lines[i].trim();
        break;
      }
    }

    // For source rules, if we can't find a line match the pattern might span
    // lines. Report line 0 with truncated source as evidence.
    if (matchLine === 0) {
      matchLine = 1;
      matchEvidence = source.slice(0, 120);
    }

    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: matchLine,
      message: rule.message,
      evidence: truncateEvidence(matchEvidence),
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
    includeFiles: opts?.includeFiles ?? [],
    maxFiles: Math.max(1, opts?.maxFiles ?? DEFAULT_MAX_SCAN_FILES),
    maxFileBytes: Math.max(1, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
  };
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function walkDirWithLimit(dirPath: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [dirPath];

  while (stack.length > 0 && files.length < maxFiles) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (isScannable(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
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

  const walkedFiles = await walkDirWithLimit(dirPath, opts.maxFiles);
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

async function readScannableSource(filePath: string, maxFileBytes: number): Promise<string | null> {
  let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    st = await fs.stat(filePath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
  if (!st?.isFile() || st.size > maxFileBytes) {
    return null;
  }
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

export async function scanDirectory(
  dirPath: string,
  opts?: SkillScanOptions,
): Promise<SkillScanFinding[]> {
  const scanOptions = normalizeScanOptions(opts);
  const files = await collectScannableFiles(dirPath, scanOptions);
  const allFindings: SkillScanFinding[] = [];

  for (const file of files) {
    const source = await readScannableSource(file, scanOptions.maxFileBytes);
    if (source == null) {
      continue;
    }
    const findings = scanSource(source, file);
    allFindings.push(...findings);
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

  for (const file of files) {
    const source = await readScannableSource(file, scanOptions.maxFileBytes);
    if (source == null) {
      continue;
    }
    scannedFiles += 1;
    const findings = scanSource(source, file);
    allFindings.push(...findings);
  }

  return {
    scannedFiles,
    critical: allFindings.filter((f) => f.severity === "critical").length,
    warn: allFindings.filter((f) => f.severity === "warn").length,
    info: allFindings.filter((f) => f.severity === "info").length,
    findings: allFindings,
  };
}
