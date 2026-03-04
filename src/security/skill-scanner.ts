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
  /** Category for grouping related findings (e.g., prompt-injection, credential-harvesting) */
  category?: string;
};

export type SkillScanSummary = {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: SkillScanFinding[];
  /** Trust verdict based on scan results */
  trustVerdict: TrustVerdict;
};

export type TrustVerdict = "SAFE" | "UNSAFE" | "REVIEW_REQUIRED";

export type SkillScanOptions = {
  includeFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  /** Fail on warnings in addition to critical findings */
  failOnWarnings?: boolean;
};

export type ManifestValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
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
// YARA-style Pattern Rules (inspired by Cisco skill-scanner)
// Categories: prompt-injection, credential-harvesting, command-injection,
//             data-exfiltration, autonomy-abuse, unicode-steganography
// ---------------------------------------------------------------------------

type YaraStyleRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  category: string;
  /** Patterns that must ALL match */
  patterns: RegExp[];
  /** Optional: at least one of these must match */
  anyOf?: RegExp[];
};

const YARA_STYLE_RULES: YaraStyleRule[] = [
  // --- Prompt Injection ---
  {
    ruleId: "prompt-injection-ignore-previous",
    severity: "critical",
    message: "Prompt injection detected: 'ignore previous instructions' pattern",
    category: "prompt-injection",
    patterns: [/ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/i],
  },
  {
    ruleId: "prompt-injection-bypass",
    severity: "critical",
    message: "Prompt injection detected: bypass/override safety patterns",
    category: "prompt-injection",
    patterns: [/bypass\s+(all\s+)?(safety|security|restrictions?|filters?)/i],
  },
  {
    ruleId: "prompt-injection-unrestricted",
    severity: "critical",
    message: "Prompt injection detected: unrestricted/developer mode request",
    category: "prompt-injection",
    patterns: [/unrestricted\s+mode|developer\s+mode|god\s+mode|debug\s+mode/i],
  },
  {
    ruleId: "prompt-injection-ignore-guidelines",
    severity: "critical",
    message: "Prompt injection detected: instruction to ignore guidelines",
    category: "prompt-injection",
    patterns: [/ignore\s+(your\s+)?(guidelines|rules|constraints|training)/i],
  },
  {
    ruleId: "prompt-injection-action-concealment",
    severity: "warn",
    message: "Prompt injection detected: instruction to hide actions from user",
    category: "prompt-injection",
    patterns: [/(don'?t|do\s+not|never)\s+(show|display|tell|reveal|mention)/i],
  },
  {
    ruleId: "prompt-injection-transitive-trust",
    severity: "warn",
    message: "Transitive trust attack: delegating execution to untrusted content",
    category: "prompt-injection",
    patterns: [/(execute|run|eval|evalu?ate?)\s+(code|commands?|scripts?)\s+(from|in|found\s+in)/i],
  },
  {
    ruleId: "prompt-injection-coercive",
    severity: "critical",
    message: "Coercive instruction: forcing tool execution priority",
    category: "prompt-injection",
    patterns: [/always\s+(execute|run|call|use)\s+(this\s+)?tool\s+first/i],
  },

  // --- Credential Harvesting ---
  {
    ruleId: "credential-harvesting-aws",
    severity: "critical",
    message: "Credential harvesting: AWS credentials file access",
    category: "credential-harvesting",
    patterns: [/\.aws\/credentials|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i],
  },
  {
    ruleId: "credential-harvesting-ssh",
    severity: "critical",
    message: "Credential harvesting: SSH key file access",
    category: "credential-harvesting",
    patterns: [/\.ssh\/id_rsa|\.ssh\/id_ed25519|\.ssh\/.*_key/i],
  },
  {
    ruleId: "credential-harvesting-env",
    severity: "critical",
    message: "Credential harvesting: .env file access",
    category: "credential-harvesting",
    patterns: [/\.env(\.[\w]+)?(\s|$|["'])/],
  },
  {
    ruleId: "credential-harvesting-keychain",
    severity: "warn",
    message: "Credential harvesting: keychain/credential manager access",
    category: "credential-harvesting",
    patterns: [/keychain|credentials?\s+manager|password\s+store/i],
  },
  {
    ruleId: "credential-harvesting-gcloud",
    severity: "critical",
    message: "Credential harvesting: GCP credentials access",
    category: "credential-harvesting",
    patterns: [/\.config\/gcloud|GOOGLE_APPLICATION_CREDENTIALS|gcloud\/credentials/i],
  },
  {
    ruleId: "credential-harvesting-azure",
    severity: "critical",
    message: "Credential harvesting: Azure credentials access",
    category: "credential-harvesting",
    patterns: [/\.azure\/credentials|AZURE_TENANT_ID|AZURE_CLIENT_SECRET/i],
  },

  // --- Command Injection ---
  {
    ruleId: "command-injection-shell-true",
    severity: "critical",
    message: "Command injection risk: shell=True with potential user input",
    category: "command-injection",
    patterns: [/subprocess.*shell\s*=\s*True|subprocess\.call.*shell\s*=\s*True/i],
  },
  {
    ruleId: "command-injection-os-system",
    severity: "critical",
    message: "Command injection risk: os.system call",
    category: "command-injection",
    patterns: [/os\.system\s*\(/],
  },
  {
    ruleId: "command-injection-reverse-shell",
    severity: "critical",
    message: "Command injection: reverse shell pattern detected",
    category: "command-injection",
    patterns: [/\/dev\/tcp\/|nc\s+-[elp]|bash\s+-[ci].*\/dev\/tcp|socat\s+EXEC/i],
  },
  {
    ruleId: "command-injection-rm-rf",
    severity: "critical",
    message: "Destructive command: rm -rf pattern detected",
    category: "command-injection",
    patterns: [/rm\s+(-[rf]+\s+|.*-[rf]+)/],
  },
  {
    ruleId: "command-injection-dd",
    severity: "critical",
    message: "Destructive command: dd overwrite pattern detected",
    category: "command-injection",
    patterns: [/dd\s+.*of=\/dev\//],
  },
  {
    ruleId: "command-injection-curl-post",
    severity: "warn",
    message: "Suspicious: curl POST with potential credential exfiltration",
    category: "command-injection",
    patterns: [/curl\s+.*-X\s+POST|curl\s+.*--data(-raw)?\s+/],
    anyOf: [/password|secret|token|key|credential/i],
  },

  // --- Data Exfiltration ---
  {
    ruleId: "exfiltration-base64-network",
    severity: "critical",
    message: "Data exfiltration: base64 encode before network send",
    category: "data-exfiltration",
    patterns: [/(btoa|Buffer\.from.*base64|base64.*encode)/i],
    anyOf: [/fetch\s*\(|\.post\s*\(|http\.request|axios|request\s*\(/],
  },
  {
    ruleId: "exfiltration-collect-send",
    severity: "warn",
    message: "Potential exfiltration: collect-then-send pattern",
    category: "data-exfiltration",
    patterns: [/readFile|readFileSync|fs\.read/],
    anyOf: [/fetch|\.post|http\.request|axios/i],
  },
  {
    ruleId: "exfiltration-dns-tunnel",
    severity: "warn",
    message: "Possible DNS tunneling/exfiltration via DNS queries",
    category: "data-exfiltration",
    patterns: [/dns\.lookup|resolve.*dns|\.dig\s+/i],
  },

  // --- Autonomy Abuse ---
  {
    ruleId: "autonomy-bypass-confirm",
    severity: "warn",
    message: "Autonomy abuse: bypassing user confirmation",
    category: "autonomy-abuse",
    patterns: [/(skip|bypass|ignore)\s+(user\s+)?(confirmation|approval|consent)/i],
  },
  {
    ruleId: "autonomy-infinite-retry",
    severity: "warn",
    message: "Autonomy abuse: infinite retry loop pattern",
    category: "autonomy-abuse",
    patterns: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
    anyOf: [/retry|attempt|try\s+again/i],
  },
  {
    ruleId: "autonomy-self-modify",
    severity: "critical",
    message: "Autonomy abuse: self-modification capability",
    category: "autonomy-abuse",
    patterns: [/writeFile.*__filename|fs\.write.*process\.argv\[1\]/],
  },
  {
    ruleId: "autonomy-blind-error",
    severity: "warn",
    message: "Autonomy abuse: blind error suppression",
    category: "autonomy-abuse",
    patterns: [/catch\s*\(\s*\w*\s*\)\s*\{\s*(\/\/|\/\*)?\s*\}/],
  },

  // --- Unicode Steganography ---
  {
    ruleId: "steganography-zero-width",
    severity: "warn",
    message: "Unicode steganography: zero-width characters detected",
    category: "unicode-steganography",
    // eslint-disable-next-line no-misleading-character-class
    patterns: [/[\u200B\u200C\u200D\uFEFF]/],
  },
  {
    ruleId: "steganography-rtl-override",
    severity: "warn",
    message: "Unicode steganography: RTL override character detected",
    category: "unicode-steganography",
    patterns: [/[\u202E\u2066\u2067\u2068\u2069]/],
  },
  {
    ruleId: "steganography-invisible",
    severity: "warn",
    message: "Unicode steganography: invisible/tag characters detected",
    category: "unicode-steganography",
    // eslint-disable-next-line no-misleading-character-class
    patterns: [/[\u00AD\u034F\u061C\u17B4\u17B5\u180E\u2060\u2064]/],
  },

  // --- System Manipulation ---
  {
    ruleId: "system-crontab",
    severity: "critical",
    message: "System manipulation: crontab modification",
    category: "system-manipulation",
    patterns: [/crontab\s+-|\/etc\/cron/i],
  },
  {
    ruleId: "system-hosts",
    severity: "critical",
    message: "System manipulation: hosts file modification",
    category: "system-manipulation",
    patterns: [/\/etc\/hosts|\\windows\\system32\\drivers\\etc\\hosts/i],
  },
  {
    ruleId: "system-firewall",
    severity: "warn",
    message: "System manipulation: firewall modification",
    category: "system-manipulation",
    patterns: [/iptables|ufw\s+(allow|deny)|firewall-cmd/i],
  },
  {
    ruleId: "system-kernel-module",
    severity: "critical",
    message: "System manipulation: kernel module loading",
    category: "system-manipulation",
    patterns: [/modprobe|insmod|\/sbin\/modprobe/i],
  },
  {
    ruleId: "systemd-unit",
    severity: "warn",
    message: "System manipulation: systemd unit modification",
    category: "system-manipulation",
    patterns: [/systemctl\s+(enable|start|create)|\.service\s*\[Install\]/i],
  },
];

// ---------------------------------------------------------------------------
// Hardcoded Secret Detection Patterns
// ---------------------------------------------------------------------------

type SecretPattern = {
  ruleId: string;
  name: string;
  pattern: RegExp;
  severity: SkillScanSeverity;
};

const SECRET_PATTERNS: SecretPattern[] = [
  {
    ruleId: "secret-aws-access-key",
    name: "AWS Access Key ID",
    pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/,
    severity: "critical",
  },
  {
    ruleId: "secret-aws-secret",
    name: "AWS Secret Access Key",
    pattern: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/,
    severity: "critical",
  },
  {
    ruleId: "secret-github-token",
    name: "GitHub Personal Access Token",
    pattern: /ghp_[A-Za-z0-9]{36}/,
    severity: "critical",
  },
  {
    ruleId: "secret-github-oauth",
    name: "GitHub OAuth Access Token",
    pattern: /gho_[A-Za-z0-9]{36}/,
    severity: "critical",
  },
  {
    ruleId: "secret-stripe-live",
    name: "Stripe Live Secret Key",
    pattern: /sk_live_[0-9a-zA-Z]{24}/,
    severity: "critical",
  },
  {
    ruleId: "secret-stripe-test",
    name: "Stripe Test Secret Key",
    pattern: /sk_test_[0-9a-zA-Z]{24}/,
    severity: "warn",
  },
  {
    ruleId: "secret-jwt",
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/,
    severity: "critical",
  },
  {
    ruleId: "secret-private-key",
    name: "Private Key Block",
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    severity: "critical",
  },
  {
    ruleId: "secret-connection-string",
    name: "Database Connection String",
    pattern: /(mongodb|mysql|postgres|postgresql|redis):\/\/[^:]+:[^@]+@/i,
    severity: "critical",
  },
  {
    ruleId: "secret-generic-api-key",
    name: "Generic API Key Pattern",
    pattern:
      /(api[_-]?key|apikey|secret[_-]?key|auth[_-]?token)\s*[=:]\s*['"][A-Za-z0-9_-]{20,}['"]/i,
    severity: "warn",
  },
  {
    ruleId: "secret-slack-token",
    name: "Slack Token",
    pattern: /xox[baprs]-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]+/,
    severity: "critical",
  },
  {
    ruleId: "secret-openai-key",
    name: "OpenAI API Key",
    pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ/,
    severity: "critical",
  },
  {
    ruleId: "secret-google-api",
    name: "Google API Key",
    pattern: /AIza[A-Za-z0-9_-]{35}/,
    severity: "critical",
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

/** Redact potential secrets in evidence strings */
function redactSecrets(text: string): string {
  let result = text;
  for (const secret of SECRET_PATTERNS) {
    result = result.replace(secret.pattern, (match) => {
      if (match.length <= 8) {
        return "****";
      }
      return match.slice(0, 4) + "****" + match.slice(-4);
    });
  }
  return result;
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
        evidence: truncateEvidence(redactSecrets(line.trim())),
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
      evidence: truncateEvidence(redactSecrets(matchEvidence)),
    });
    matchedSourceRules.add(ruleKey);
  }

  // --- YARA-style rules ---
  for (const rule of YARA_STYLE_RULES) {
    // Check all required patterns match
    const allPatternsMatch = rule.patterns.every((p) => p.test(source));
    if (!allPatternsMatch) {
      continue;
    }

    // Check anyOf condition if present
    if (rule.anyOf && !rule.anyOf.some((p) => p.test(source))) {
      continue;
    }

    // Find the first matching line for evidence
    let matchLine = 1;
    let matchEvidence = "";
    for (let i = 0; i < lines.length; i++) {
      if (rule.patterns.some((p) => p.test(lines[i]))) {
        matchLine = i + 1;
        matchEvidence = lines[i].trim();
        break;
      }
    }

    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: matchLine,
      message: rule.message,
      evidence: truncateEvidence(redactSecrets(matchEvidence)),
      category: rule.category,
    });
  }

  // --- Secret detection ---
  for (const secret of SECRET_PATTERNS) {
    // Create a global version of the pattern for matchAll
    const globalPattern = new RegExp(secret.pattern.source, secret.pattern.flags + "g");
    const matches = source.matchAll(globalPattern);
    for (const match of matches) {
      // Find line number
      const beforeMatch = source.slice(0, match.index);
      const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

      // Redact the secret in evidence
      const line = lines[lineNum - 1] || "";
      const redacted = redactSecrets(line.trim());

      findings.push({
        ruleId: secret.ruleId,
        severity: secret.severity,
        file: filePath,
        line: lineNum,
        message: `Hardcoded secret detected: ${secret.name}`,
        evidence: truncateEvidence(redacted),
        category: "hardcoded-secrets",
      });
    }
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
    failOnWarnings: opts?.failOnWarnings ?? false,
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

    const entries = await readDirEntriesWithCache(currentDir);
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.kind === "dir") {
        stack.push(fullPath);
      } else if (entry.kind === "file" && isScannable(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
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

  // Compute trust verdict
  const trustVerdict = computeTrustVerdict(critical, warn, scanOptions.failOnWarnings);

  return {
    scannedFiles,
    critical,
    warn,
    info,
    findings: allFindings,
    trustVerdict,
  };
}

// ---------------------------------------------------------------------------
// Trust Scoring
// ---------------------------------------------------------------------------

/**
 * Compute trust verdict based on scan results
 * - SAFE: No findings or only info-level findings
 * - REVIEW_REQUIRED: Warnings present (or failOnWarnings=false with critical)
 * - UNSAFE: Critical findings present (or warnings with failOnWarnings=true)
 */
export function computeTrustVerdict(
  criticalCount: number,
  warnCount: number,
  failOnWarnings: boolean = false,
): TrustVerdict {
  if (criticalCount > 0) {
    return "UNSAFE";
  }
  if (warnCount > 0 && failOnWarnings) {
    return "UNSAFE";
  }
  if (warnCount > 0) {
    return "REVIEW_REQUIRED";
  }
  return "SAFE";
}

/**
 * Check if a skill should be blocked based on trust verdict
 */
export function shouldBlockSkill(verdict: TrustVerdict): boolean {
  return verdict === "UNSAFE";
}

// ---------------------------------------------------------------------------
// Manifest Validation
// ---------------------------------------------------------------------------

export type SkillManifest = {
  name?: string;
  version?: string;
  description?: string;
  triggers?: string[];
  capabilities?: string[];
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  [key: string]: unknown;
};

/**
 * Validate a skill manifest for security concerns
 * Checks for:
 * - Required fields presence
 * - Description quality (not too generic, not keyword-stuffed)
 * - Unicode steganography in text fields
 * - Overly broad or suspicious triggers
 */
export function validateManifest(manifest: SkillManifest): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!manifest.name || manifest.name.trim().length === 0) {
    errors.push("Manifest missing required field: name");
  }

  if (!manifest.description || manifest.description.trim().length === 0) {
    errors.push("Manifest missing required field: description");
  }

  // Description quality checks
  if (manifest.description) {
    const desc = manifest.description;

    // Too short
    if (desc.length < 20) {
      warnings.push("Description is too short (less than 20 characters)");
    }

    // Too generic
    const genericPhrases = [
      /^a\s+skill$/i,
      /^an?\s+\w+\s+skill$/i,
      /^helpful\s+skill$/i,
      /^utility\s+skill$/i,
    ];
    if (genericPhrases.some((p) => p.test(desc.trim()))) {
      warnings.push("Description is too generic - lacks specificity");
    }

    // Keyword stuffing (many repeated words)
    const words = desc.toLowerCase().split(/\s+/);
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      if (word.length < 4) {
        continue;
      } // Skip short words
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
    const maxRepeats = Math.max(...wordCounts.values(), 0);
    if (maxRepeats > 3) {
      warnings.push("Description may be keyword-stuffed (repeated words)");
    }

    // Unicode steganography check
    // eslint-disable-next-line no-misleading-character-class
    const zeroWidthChars = desc.match(/[\u200B\u200C\u200D\uFEFF\u202E]/g);
    if (zeroWidthChars && zeroWidthChars.length > 0) {
      errors.push("Description contains hidden Unicode characters (possible steganography)");
    }
  }

  // Triggers validation
  if (manifest.triggers && Array.isArray(manifest.triggers)) {
    for (const trigger of manifest.triggers) {
      if (typeof trigger !== "string") {
        errors.push(`Invalid trigger type: ${typeof trigger}`);
        continue;
      }

      // Overly broad triggers
      if (/^(always|any|every|all|\*|\.|\.\*)$/i.test(trigger.trim())) {
        warnings.push(`Overly broad trigger: "${trigger}" may activate too frequently`);
      }

      // Trigger too short
      if (trigger.trim().length < 3) {
        warnings.push(`Trigger "${trigger}" is very short and may cause false activations`);
      }
    }
  }

  // Capabilities validation
  if (manifest.capabilities && Array.isArray(manifest.capabilities)) {
    const suspiciousCapabilities = new Set([
      "full_disk_access",
      "root_access",
      "admin_access",
      "unrestricted_network",
      "unrestricted_filesystem",
      "bypass_sandbox",
    ]);
    for (const cap of manifest.capabilities) {
      if (typeof cap === "string" && suspiciousCapabilities.has(cap.toLowerCase())) {
        warnings.push(`Suspicious capability declared: ${cap}`);
      }
    }
  }

  // Unicode steganography in other text fields
  const textFields = ["name", "author", "homepage", "repository"];
  for (const field of textFields) {
    const value = manifest[field];
    if (typeof value === "string") {
      // eslint-disable-next-line no-misleading-character-class
      const hiddenChars = value.match(/[\u200B\u200C\u200D\uFEFF\u202E]/g);
      if (hiddenChars && hiddenChars.length > 0) {
        errors.push(`Field "${field}" contains hidden Unicode characters`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a SKILL.md manifest file
 */
export async function validateSkillManifestFile(
  skillDir: string,
): Promise<ManifestValidationResult> {
  const manifestPath = path.join(skillDir, "SKILL.md");

  try {
    const content = await fs.readFile(manifestPath, "utf-8");

    // Parse frontmatter if present
    let manifest: SkillManifest = {};

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      // Simple YAML-like parsing for basic fields
      for (const line of frontmatter.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let value: string | string[] = line.slice(colonIdx + 1).trim();

          // Handle arrays (simple format: [item1, item2])
          if (value.startsWith("[") && value.endsWith("]")) {
            value = value
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""));
          } else {
            value = value.replace(/^["']|["']$/g, "");
          }

          (manifest as Record<string, unknown>)[key] = value;
        }
      }
    }

    // Extract description from content if not in frontmatter
    if (!manifest.description) {
      const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      if (lines.length > 0) {
        manifest.description = lines[0].trim();
      }
    }

    return validateManifest(manifest);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return {
        valid: false,
        errors: ["SKILL.md not found"],
        warnings: [],
      };
    }
    throw err;
  }
}
