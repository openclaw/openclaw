import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import { isPathInside } from "./scan-paths.js";
import type { SkillCapability } from "../agents/skills/types.js";

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

export function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

  // --- Line rules ---
  for (const rule of LINE_RULES) {
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

      // Special handling for suspicious-network: check port
      if (rule.ruleId === "suspicious-network") {
        const port = parseInt(match[1], 10);
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
// SKILL.md content scanner
// ---------------------------------------------------------------------------
// These rules scan natural language content (not code) for prompt injection,
// suspicious patterns, and capability mismatches.
//
// CLAWHUB ALIGNMENT: The suspicious.* patterns below match ClawHub's
// FLAG_RULES in clawhub/convex/lib/moderation.ts. Keep them in sync.

type MarkdownRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
};

const SKILL_MD_RULES: MarkdownRule[] = [
  // --- Prompt injection patterns (from external-content.ts SUSPICIOUS_PATTERNS) ---
  {
    ruleId: "prompt-injection-override",
    severity: "critical",
    message: "Prompt injection: attempts to override previous instructions",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  },
  {
    ruleId: "prompt-injection-disregard",
    severity: "critical",
    message: "Prompt injection: attempts to disregard instructions",
    pattern: /disregard\s+(all\s+)?(previous|prior|above)/i,
  },
  {
    ruleId: "prompt-injection-forget",
    severity: "critical",
    message: "Prompt injection: attempts to reset agent behavior",
    pattern: /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
  },
  {
    ruleId: "role-override",
    severity: "critical",
    message: "Prompt injection: role override attempt",
    pattern: /you\s+are\s+now\s+(a|an)\s+/i,
  },
  {
    ruleId: "system-tag-injection",
    severity: "critical",
    message: "Prompt injection: system/role tag injection",
    pattern: /<\/?system>|\]\s*\n?\s*\[?(system|assistant|user)\]?:/i,
  },
  {
    ruleId: "boundary-spoofing",
    severity: "critical",
    message: "Boundary marker spoofing detected",
    pattern: /<<<\s*EXTERNAL_UNTRUSTED_CONTENT\s*>>>/i,
  },
  {
    ruleId: "destructive-command",
    severity: "critical",
    message: "Destructive command pattern detected",
    pattern: /rm\s+-rf|delete\s+all\s+(emails?|files?|data)/i,
  },

  // --- ClawHub FLAG_RULES alignment (clawhub/convex/lib/moderation.ts) ---
  {
    ruleId: "suspicious.keyword",
    severity: "critical",
    message: "Suspicious keyword detected (malware/stealer/phishing)",
    pattern: /(malware|stealer|phish|phishing|keylogger)/i,
  },
  {
    ruleId: "suspicious.secrets",
    severity: "warn",
    message: "References to secrets or credentials",
    pattern: /(api[-_ ]?key|private key|secret).*(?:send|post|fetch|upload|exfil)/i,
  },
  {
    ruleId: "suspicious.webhook",
    severity: "warn",
    message: "Webhook or external communication endpoint",
    pattern: /(discord\.gg|hooks\.slack)/i,
  },
  {
    ruleId: "suspicious.script",
    severity: "critical",
    message: "Pipe-to-shell pattern detected",
    pattern: /(curl[^\n]+\|\s*(sh|bash))/i,
  },
  {
    ruleId: "suspicious.url_shortener",
    severity: "warn",
    message: "URL shortener detected (potential phishing vector)",
    pattern: /(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i,
  },

  // --- Capability inflation ---
  {
    ruleId: "capability-inflation",
    severity: "warn",
    message: "Claims unrestricted system access",
    pattern: /you\s+have\s+(full|unrestricted|unlimited)\s+access/i,
  },
  {
    ruleId: "new-instructions",
    severity: "warn",
    message: "Attempts to inject new instructions",
    pattern: /new\s+instructions?:/i,
  },

  // --- Hidden content ---
  {
    ruleId: "zero-width-chars",
    severity: "warn",
    message: "Suspicious zero-width character cluster detected",
    pattern: /[\u200B\u200C\u200D\uFEFF]{3,}/,
  },
];

/**
 * Capability mismatch rules — detect when SKILL.md content references
 * tools/actions that aren't declared in the skill's capabilities.
 */
const CAPABILITY_MISMATCH_PATTERNS: Array<{
  capability: SkillCapability;
  pattern: RegExp;
  label: string;
}> = [
  {
    capability: "shell",
    pattern: /\b(exec|run\s+command|shell|terminal|bash|subprocess|child.process)\b/i,
    label: "shell commands",
  },
  {
    capability: "filesystem",
    pattern: /\b(write\s+file|edit\s+file|create\s+file|save\s+to|modify\s+file|delete\s+file|fs_write)\b/i,
    label: "file mutations",
  },
  {
    capability: "sessions",
    pattern: /\b(spawn\s+agent|sessions?_spawn|sessions?_send|subagent|cross.session)\b/i,
    label: "session orchestration",
  },
  {
    capability: "network",
    pattern: /\b(fetch\s+url|web_search|web_fetch|http\s+request|outbound\s+request)\b/i,
    label: "network access",
  },
];

export type SkillMarkdownScanResult = {
  severity: SkillScanSeverity | "clean";
  findings: SkillScanFinding[];
};

/**
 * Scan SKILL.md content for prompt injection, suspicious patterns, and
 * capability mismatches.
 *
 * @param content - Raw SKILL.md content (including frontmatter)
 * @param filePath - Path for reporting
 * @param declaredCapabilities - Capabilities from frontmatter (if any)
 */
export function scanSkillMarkdown(
  content: string,
  filePath: string,
  declaredCapabilities?: SkillCapability[],
): SkillMarkdownScanResult {
  const findings: SkillScanFinding[] = [];
  const lines = content.split("\n");
  const matched = new Set<string>();

  // --- Pattern rules ---
  for (const rule of SKILL_MD_RULES) {
    if (matched.has(rule.ruleId)) {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          file: filePath,
          line: i + 1,
          message: rule.message,
          evidence: truncateEvidence(lines[i].trim()),
        });
        matched.add(rule.ruleId);
        break;
      }
    }
  }

  // --- Capability mismatch detection ---
  const capSet = new Set<string>(declaredCapabilities ?? []);
  for (const mismatch of CAPABILITY_MISMATCH_PATTERNS) {
    if (capSet.has(mismatch.capability)) {
      continue; // Declared, no mismatch
    }
    for (let i = 0; i < lines.length; i++) {
      if (mismatch.pattern.test(lines[i])) {
        findings.push({
          ruleId: `capability-mismatch.${mismatch.capability}`,
          severity: "warn",
          file: filePath,
          line: i + 1,
          message: `References ${mismatch.label} but does not declare "${mismatch.capability}" capability`,
          evidence: truncateEvidence(lines[i].trim()),
        });
        break;
      }
    }
  }

  // Determine overall severity
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasWarn = findings.some((f) => f.severity === "warn");
  const severity: SkillMarkdownScanResult["severity"] = hasCritical
    ? "critical"
    : hasWarn
      ? "warn"
      : findings.length > 0
        ? "info"
        : "clean";

  return { severity, findings };
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
