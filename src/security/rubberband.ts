/**
 * RubberBand - Static detection for exec commands
 * Catches dangerous command patterns that prompt injection may trick the agent into running.
 */

import { logInfo, logWarn } from "../logger.js";

// ============ TYPES ============

export type RubberBandDisposition = "ALLOW" | "LOG" | "ALERT" | "BLOCK";

export type RubberBandMatch = {
  rule_id: string;
  category: string;
  score: number;
  pattern?: string;
};

export type RubberBandResult = {
  disposition: RubberBandDisposition;
  score: number;
  matches: RubberBandMatch[];
  factors: string[];
};

export type RubberBandConfig = {
  enabled: boolean;
  mode: "block" | "alert" | "log" | "off" | "shadow";
  thresholds: {
    alert: number;
    block: number;
  };
  allowedDestinations: string[];
};

// ============ DEFAULT CONFIG ============

// Max command length to analyze (prevents ReDoS and abuse)
const MAX_COMMAND_LENGTH = 10_000;

const DEFAULT_CONFIG: RubberBandConfig = {
  enabled: true,
  mode: "block",
  thresholds: {
    alert: 40,
    block: 60,
  },
  allowedDestinations: [
    "localhost",
    "127.0.0.1",
    "api.github.com",
    "api.anthropic.com",
    "api.openai.com",
  ],
};

// ============ CONTEXT-AWARE PREPROCESSING ============

/**
 * Strip quoted content from commands where the quotes contain user text, not commands.
 * This prevents false positives from git commit messages, echo statements, etc.
 * Returns [strippedCommand, wasStripped] to enable context-dependent scoring.
 */
function stripContextSafeContent(command: string): [stripped: string, wasStripped: boolean] {
  let stripped = command;
  let wasStripped = false;

  // Git commit messages - strip -m "..." or -m '...'
  if (/^git\s+(commit|tag|stash)/.test(command)) {
    const result = command.replace(/-m\s*["'][^"']*["']/g, '-m "[MESSAGE]"');
    if (result !== command) {
      stripped = result;
      wasStripped = true;
    }
    return [stripped, wasStripped];
  }

  // Echo/printf statements - the content is output, not executed
  if (/^(echo|printf)\s/.test(command)) {
    const result = command.replace(/["'][^"']*["']/g, '"[TEXT]"');
    if (result !== command) {
      stripped = result;
      wasStripped = true;
    }
    return [stripped, wasStripped];
  }

  // Log/write operations - content is data, not commands
  if (/^(logger|wall|write|notify-send)\s/.test(command)) {
    const result = command.replace(/["'][^"']*["']/g, '"[TEXT]"');
    if (result !== command) {
      stripped = result;
      wasStripped = true;
    }
    return [stripped, wasStripped];
  }

  // Heredoc content is data, not commands - strip the entire command
  // Matches: cat/tee ... << 'DELIM' ... DELIM  or  << DELIM ... DELIM
  // When a heredoc is used, the command is a data write operation:
  //   cat >> file << EOF   (writes heredoc body to file)
  //   tee file << EOF      (writes heredoc body to file)
  // The heredoc body can contain anything (config keywords, file paths, etc.)
  // but none of it is executed as shell commands. The redirect target is also
  // just a data destination, not a command being run against that file.
  const heredocMatch = command.match(/<<-?\s*['"]?(\w+)['"]?/);
  if (heredocMatch) {
    // Check for piped execution: cat << EOF | bash  or  cat << EOF | sh
    // These are dangerous - the heredoc body IS executed
    const firstLine = command.split("\n")[0];
    if (/\|\s*(sh|bash|zsh|dash|python|ruby|perl|node)\b/.test(firstLine)) {
      // Don't strip - let normal detection handle the piped execution
      return [command, false];
    }
    // Safe heredoc write - strip the entire command
    // The redirect target and heredoc body are data operations
    stripped = "[HEREDOC_WRITE]";
    wasStripped = true;
    return [stripped, wasStripped];
  }

  return [command, false];
}

// ============ DETECTION PATTERNS ============

// Common file reader commands
const FILE_READERS =
  "(cat|head|tail|less|more|vim|sed|awk|grep|tac|dd|xxd|strings|od|python3?|ruby|perl|php|node)";

type PatternRule = {
  patterns: RegExp[];
  score: number;
  category: string;
};

const PATTERNS: Record<string, PatternRule> = {
  ssh_key_access: {
    patterns: [
      new RegExp(`${FILE_READERS}\\s+.*\\.ssh/(id_rsa|id_ed25519|id_ecdsa|.*\\.pem)`, "i"),
      /\.ssh\/(id_rsa|id_ed25519|id_ecdsa)/i,
      /-----BEGIN\s+(RSA|OPENSSH|EC|PRIVATE)\s+.*KEY-----/i,
    ],
    score: 70,
    category: "credential_access",
  },
  aws_credentials: {
    patterns: [
      new RegExp(`${FILE_READERS}\\s+.*\\.aws/credentials`, "i"),
      /\.aws\/credentials/i,
      /AKIA[0-9A-Z]{16}/,
    ],
    score: 70,
    category: "credential_access",
  },
  misc_credentials: {
    patterns: [
      /\.(kube\/config|docker\/config\.json|netrc|pgpass|my\.cnf|npmrc|pypirc)/i,
      /_credentials/i,
      /\.config\/gh\/hosts/i,
      new RegExp(`${FILE_READERS}\\s+.*\\.(pem|key|p12|pfx|jks)`, "i"),
    ],
    score: 60,
    category: "credential_access",
  },
  api_key_leak: {
    patterns: [
      /sk-[A-Za-z0-9]{48}/, // OpenAI
      /sk-ant-[A-Za-z0-9-]{90,}/, // Anthropic
      /ghp_[A-Za-z0-9]{36}/, // GitHub PAT
      /gho_[A-Za-z0-9]{36}/, // GitHub OAuth
      /xox[bp]-[A-Za-z0-9-]{10,}/, // Slack
      /glpat-[A-Za-z0-9_-]{20,}/, // GitLab
      /npm_[A-Za-z0-9]{36,}/, // npm
    ],
    score: 60,
    category: "secret_exposure",
  },
  network_exfil: {
    patterns: [
      /curl\s+.*-X\s*POST.*(-d|--data)/i,
      /curl\s+.*--data-binary\s+@/i,
      /wget\s+--post-(data|file)/i,
      /(httpie|http)\s+POST/i,
      /requests\.(post|put)/i,
      /nc\s+\S+\s+\d+\s*</i,
      /<.*\|\s*nc\s+/i,
    ],
    score: 40,
    category: "exfiltration",
  },
  indirect_execution: {
    patterns: [
      /\beval\s+/i,
      /\|\s*(sh|bash|zsh|dash)\b/i,
      /bash\s+(-c|<<<)/i,
      /sh\s+-c/i,
      /echo.*\|\s*(sh|bash)/i,
      /base64\s+-d.*\|\s*(sh|bash)/i,
      /\$\(base64\s+-d/i,
    ],
    score: 40,
    category: "indirect_execution",
  },
  encoding_sensitive: {
    patterns: [
      /base64\s+.*\.(pem|key|env|ssh)/i,
      /base64\.b64encode/i,
      /base64\s+~\/?\./, // base64 encoding dotfiles
    ],
    score: 30,
    category: "obfuscation",
  },
  keychain_access: {
    patterns: [/security\s+find-(generic|internet)-password/i, /Keychain.*\.keychain/i],
    score: 80,
    category: "credential_access",
  },
  persistence: {
    patterns: [
      /crontab\s+-[el]/i,
      /launchctl\s+(load|submit)/i,
      /systemctl.*enable/i,
      /echo.*>>\s*~?\/?\.?(bashrc|zshrc|profile)/i,
    ],
    score: 60,
    category: "persistence",
  },
  env_staging: {
    patterns: [/export\s+\w+=.*\.ssh/i, /export\s+\w+=.*\.aws/i, /export\s+\w+=.*credentials/i],
    score: 25,
    category: "staging",
  },
  // Post-injection static patterns
  // NOTE: Use [^;|&\n]* instead of .* to prevent matching across command separators
  config_tampering: {
    patterns: [
      // Redirect writes - use non-greedy match, exclude command separators
      />\s*[^;|&\n]*clawdbot\.json/i,
      />\s*[^;|&\n]*openclaw\.json/i,
      // Match .clawdbot/ and .openclaw/ config paths but EXCLUDE workspace/ subtree
      // The workspace/ directory is the agent's working area (projects, scripts, etc.)
      />\s*[^;|&\n]*\.clawdbot\/(?!workspace\/)[^;|&\n]*[^/\s]/i,
      />\s*[^;|&\n]*\.openclaw\/(?!workspace\/)[^;|&\n]*[^/\s]/i,
      /(echo|cat|printf)[^;|&\n]*>\s*[^;|&\n]*SOUL\.md/i,
      /(echo|cat|printf)[^;|&\n]*>\s*[^;|&\n]*AGENTS\.md/i,
      // cp/mv/tee/install to config paths (exclude workspace/)
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*clawdbot\.json/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*openclaw\.json/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*\.clawdbot\/(?!workspace\/)[^;|&\n]*[^/\s]/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*\.openclaw\/(?!workspace\/)[^;|&\n]*[^/\s]/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*SOUL\.md/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*AGENTS\.md/i,
      /tee\s+[^;|&\n]*SOUL\.md/i,
      /tee\s+[^;|&\n]*AGENTS\.md/i,
      /tee\s+[^;|&\n]*clawdbot\.json/i,
      /tee\s+[^;|&\n]*openclaw\.json/i,
    ],
    score: 75,
    category: "config_tampering",
  },
  agent_memory_tampering: {
    patterns: [
      // Redirect writes - use non-greedy match, exclude command separators
      /(echo|cat|printf)[^;|&\n]*>\s*[^;|&\n]*memory\/[^;|&\n]*\.md/i,
      /(echo|cat|printf)[^;|&\n]*>>\s*[^;|&\n]*MEMORY\.md/i,
      />\s*[^;|&\n]*\.clawdbot\/sessions/i,
      />\s*[^;|&\n]*\.openclaw\/sessions/i,
      // cp/mv/tee to memory paths
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*memory\/[^;|&\n]*\.md/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*MEMORY\.md/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*\.clawdbot\/sessions/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*\.openclaw\/sessions/i,
      /tee\s+[^;|&\n]*memory\/[^;|&\n]*\.md/i,
      /tee\s+[^;|&\n]*MEMORY\.md/i,
    ],
    score: 55,
    category: "context_manipulation",
  },
  reverse_shell: {
    patterns: [
      /nc\s+.*-[elp]/i,
      /bash\s+-i\s+>&\s*\/dev\/tcp/i,
      /ngrok\s+(http|tcp)/i,
      /mkfifo.*nc\s+/i,
      /\/dev\/tcp\/\d+\.\d+/i,
      /socat\s+.*exec/i,
      /python.*socket.*connect/i,
    ],
    score: 90,
    category: "reverse_shell",
  },
  reconnaissance: {
    patterns: [
      /\bwhoami\b/i,
      /\bid\s*$/i,
      /uname\s+-a/i,
      /cat\s+\/etc\/passwd/i,
      /ps\s+(aux|ef)/i,
      /netstat\s+-[tulpan]/i,
      /\b(ifconfig|ip\s+addr)\b/i,
      /\benv\s*$/i,
      /\bprintenv\b/i,
    ],
    score: 30,
    category: "recon",
  },
  data_staging: {
    patterns: [
      />\s*\/tmp\/.*\.(txt|log|key|pem|json)/i,
      /cp\s+.*\.(pem|key|env|json)\s+\/tmp/i,
      /mv\s+.*\.(pem|key|env)\s+\/tmp/i,
      />\s*.*\/public\//i,
      />\s*.*\/www\//i,
    ],
    score: 45,
    category: "staging",
  },
  skill_tampering: {
    patterns: [
      // Redirect writes - use [^;|&\n]* to prevent matching across command separators
      // This avoids false positives like: cat file 2>/dev/null || cat skills/SKILL.md
      /(echo|cat|printf)[^;|&\n]*>\s*[^;|&\n]*SKILL\.md/i,
      />\s*[^;|&\n]*skills\/[^;|&\n]*\.md/i,
      /(echo|cat|printf)[^;|&\n]*>\s*[^;|&\n]*system[^;|&\n]*prompt/i,
      />\s*[^;|&\n]*\.claude\//i,
      // cp/mv/tee to skill paths
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*SKILL\.md/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*skills\/[^;|&\n]*\.md/i,
      /(cp|mv|install)\s+[^;|&\n]+\s+[^;|&\n]*\.claude\//i,
      /tee\s+[^;|&\n]*SKILL\.md/i,
      /tee\s+[^;|&\n]*skills\/[^;|&\n]*\.md/i,
    ],
    score: 75,
    category: "self_modification",
  },

  // === UNIX ADDITIONAL PATTERNS ===
  unix_find_exec: {
    patterns: [/find\s+.*-exec\s+/i, /find\s+.*\|.*xargs/i],
    score: 50,
    category: "indirect_execution",
  },
  unix_revshell_langs: {
    patterns: [
      /ruby\s+.*-r\s*socket/i,
      /ruby\s+.*TCPSocket/i,
      /perl\s+.*Socket/i,
      /perl\s+.*connect\s*\(/i,
      /php\s+.*fsockopen/i,
      /telnet\s+\S+\s+\d+.*\|/i,
    ],
    score: 90,
    category: "reverse_shell",
  },
  unix_persistence_extra: {
    patterns: [
      /\bat\s+(now|midnight|\d)/i,
      /\/etc\/cron\.d\//i,
      /\/etc\/init\.d\//i,
      /\/etc\/rc\.local/i,
      /\/etc\/profile\.d\//i,
      /ld\.so\.preload/i,
      /\.config\/autostart\//i,
      /LaunchAgents\//i,
    ],
    score: 70,
    category: "persistence",
  },
  container_escape: {
    patterns: [
      /docker\s+run.*-v\s+\/:/i,
      /docker\s+.*--privileged/i,
      /kubectl\s+exec/i,
      /kubectl\s+cp/i,
      /nsenter\s+/i,
    ],
    score: 80,
    category: "container_escape",
  },
  package_manager_abuse: {
    patterns: [
      /\bpip\s+install\s+git\+/i,
      /\bpip\s+install\s+https?:/i,
      /\bnpm\s+install\s+\S+/i,
      /\byarn\s+add\s+\S+/i,
    ],
    score: 40,
    category: "code_execution",
  },

  // === WINDOWS PATTERNS ===
  win_file_read: {
    patterns: [
      /\btype\s+.*\\\.ssh\\/i,
      /\btype\s+.*\\\.aws\\/i,
      /\btype\s+.*config\\SAM/i,
      /\btype\s+.*config\\SYSTEM/i,
      /\btype\s+C:\\Users\\/i,
      /\bmore\s+.*%USERPROFILE%/i,
      /\bfindstr\s+.*%USERPROFILE%/i,
      /\bfind\s+\/v\s+.*%USERPROFILE%/i,
    ],
    score: 70,
    category: "credential_access",
  },
  win_powershell_read: {
    patterns: [
      /\[System\.IO\.File\]::Read/i,
      /\[IO\.File\]::Read/i,
      /Get-Content\s+.*\.ssh/i,
      /gc\s+.*\.ssh/i,
    ],
    score: 70,
    category: "credential_access",
  },
  win_powershell_exec: {
    patterns: [
      /\bIEX\s*\(/i,
      /\bIEX\s+\$/i,
      /Invoke-Expression/i,
      /powershell\s+.*-enc\s+/i,
      /powershell\s+.*-EncodedCommand/i,
      /powershell\s+.*-ExecutionPolicy\s+Bypass/i,
      /powershell\s+.*-ep\s+bypass/i,
      /DownloadString.*\|.*IEX/i,
    ],
    score: 80,
    category: "code_execution",
  },
  win_powershell_download: {
    patterns: [
      /Invoke-WebRequest.*-OutFile/i,
      /\biwr\s+.*-OutFile/i,
      /\bwget\s+.*-OutFile/i,
      /Invoke-RestMethod.*POST/i,
      /Net\.WebClient.*Download/i,
      /Start-BitsTransfer/i,
    ],
    score: 60,
    category: "download",
  },
  win_credential_dump: {
    patterns: [
      /ntds\.dit/i,
      /reg\s+save\s+HKLM\\SAM/i,
      /reg\s+save\s+HKLM\\SYSTEM/i,
      /reg\s+save\s+HKLM\\SECURITY/i,
      /mimikatz/i,
      /sekurlsa/i,
      /procdump.*lsass/i,
      /comsvcs\.dll.*MiniDump/i,
      /lsass\.dmp/i,
    ],
    score: 95,
    category: "credential_access",
  },
  win_persistence: {
    patterns: [
      /schtasks\s+\/create/i,
      /reg\s+add.*\\Run\s/i,
      /reg\s+add.*\\RunOnce/i,
      /sc\s+create\s+/i,
      /wmic\s+.*startup/i,
      /Start Menu\\Programs\\Startup/i,
      /HKCU\\.*\\Run/i,
      /HKLM\\.*\\Run/i,
    ],
    score: 75,
    category: "persistence",
  },
  win_lateral: {
    patterns: [
      /psexec\s+\\\\/i,
      /wmic\s+\/node:/i,
      /winrm\s+invoke/i,
      /net\s+use\s+\\\\/i,
      /Enter-PSSession/i,
      /Invoke-Command.*-ComputerName/i,
    ],
    score: 70,
    category: "lateral_movement",
  },
  win_revshell: {
    patterns: [
      /Net\.Sockets\.TCPClient/i,
      /System\.Net\.Sockets/i,
      /nc\.exe\s+.*-e/i,
      /ncat\s+.*-e/i,
      /powercat/i,
    ],
    score: 90,
    category: "reverse_shell",
  },
  win_lolbins: {
    patterns: [
      /certutil\s+.*-urlcache/i,
      /certutil\s+.*-encode/i,
      /certutil\s+.*-decode/i,
      /bitsadmin\s+.*\/transfer/i,
      /mshta\s+/i,
      /msiexec\s+.*\/q.*http/i,
      /regsvr32\s+.*\/s.*\/u/i,
      /rundll32\s+.*javascript/i,
      /cscript\s+.*http/i,
      /wscript\s+.*http/i,
    ],
    score: 75,
    category: "lolbin_abuse",
  },
};

// ============ NORMALIZATION ============

/**
 * Normalize file paths to catch obfuscation
 * - Collapse multiple slashes: // → /
 * - Remove dot segments: /./ → /
 */
function normalizePaths(content: string): string {
  return content
    .replace(/\/{2,}/g, "/") // Collapse // to /
    .replace(/\/\.\//g, "/"); // Remove /./
}

/**
 * Normalize content to catch encoding bypasses
 */
function normalize(content: string): string {
  let normalized = content;

  // 1. Unicode NFKC normalization (converts lookalikes)
  normalized = normalized.normalize("NFKC");

  // 2. Expand $'...' shell escape sequences
  normalized = expandShellEscapes(normalized);

  // 3. Expand bare escape sequences (\xNN, \NNN)
  normalized = expandBareEscapes(normalized);

  // 4. URL decode (handles %XX encoding)
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) {
        break;
      }
      normalized = decoded;
    } catch {
      break;
    }
  }

  // 5. Normalize paths (collapse //, remove /./)
  normalized = normalizePaths(normalized);

  return normalized;
}

/**
 * Expand $'...' shell escape sequences
 */
function expandShellEscapes(content: string): string {
  return content.replace(/\$'([^']*)'/g, (_match, inner: string) => {
    let result = inner;
    // Handle \xNN (hex)
    result = result.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    // Handle \NNN (octal)
    result = result.replace(/\\([0-7]{1,3})/g, (_m, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    // Handle common escapes
    result = result.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    return result;
  });
}

/**
 * Expand bare escape sequences (outside of $'...')
 * Handles: \xNN (hex), \NNN (octal)
 * These can be used to bypass pattern matching in some shells
 */
function expandBareEscapes(content: string): string {
  let result = content;

  // Handle \xNN (hex) - e.g., \x69 → 'i'
  result = result.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

  // Handle \NNN (octal) - e.g., \151 → 'i'
  // Only match 3-digit octal to avoid false positives with \1 backrefs
  result = result.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );

  // Handle \NN (2-digit octal) for values that fit
  result = result.replace(/\\([0-7]{2})(?![0-7])/g, (_m, oct: string) => {
    const val = Number.parseInt(oct, 8);
    return val < 128 ? String.fromCharCode(val) : _m;
  });

  return result;
}

// ============ DETECTION ============

/**
 * Check content against all patterns
 */
function checkPatterns(content: string): RubberBandMatch[] {
  const matches: RubberBandMatch[] = [];

  for (const [ruleId, rule] of Object.entries(PATTERNS)) {
    for (const pattern of rule.patterns) {
      if (pattern.test(content)) {
        matches.push({
          rule_id: ruleId,
          category: rule.category,
          score: rule.score,
          pattern: pattern.source,
        });
        break; // One match per rule is enough
      }
    }
  }

  return matches;
}

/**
 * Extract and validate destination URLs
 */
function checkDestination(content: string, allowedDestinations: string[]): string | null {
  const urlMatch = content.match(/https?:\/\/([^/\s:]+)/i);
  if (urlMatch) {
    const host = urlMatch[1].toLowerCase();
    for (const allowed of allowedDestinations) {
      const allowedLower = allowed.toLowerCase();
      // Strict matching: exact match OR proper subdomain
      if (host === allowedLower || host.endsWith(`.${allowedLower}`)) {
        return null; // Allowed
      }
    }
    return host; // Suspicious destination
  }
  return null;
}

/**
 * Calculate overall risk score
 */
function calculateRisk(
  content: string,
  config: RubberBandConfig,
  contentWasStripped?: boolean,
): { score: number; matches: RubberBandMatch[]; factors: string[] } {
  const matches = checkPatterns(content);

  if (matches.length === 0) {
    return { score: 0, matches: [], factors: [] };
  }

  // Score stacking: sum highest score from each unique category
  // This ensures bash -c + ssh_key_access = higher risk than either alone
  const categoryScores = new Map<string, number>();
  for (const match of matches) {
    const existing = categoryScores.get(match.category) ?? 0;
    categoryScores.set(match.category, Math.max(existing, match.score));
  }

  // Sum scores from different categories (capped at 100)
  let baseScore = 0;
  for (const score of categoryScores.values()) {
    baseScore += score;
  }

  const factors: string[] = [];
  const categories = new Set(matches.map((m) => m.category));

  // Note when multiple categories contributed
  if (categoryScores.size > 1) {
    factors.push(`multi_category:${[...categoryScores.keys()].join("+")}`);
  }

  // Destination check
  const suspiciousDest = checkDestination(content, config.allowedDestinations);
  if (suspiciousDest) {
    baseScore += 30;
    factors.push(`external_destination:${suspiciousDest}`);
  }

  // Encoding + file access = higher risk (bonus on top of stacking)
  if (categories.has("obfuscation") && categories.has("credential_access")) {
    baseScore += 10;
    factors.push("encoding_credentials");
  }

  // Content was stripped (echo/git commit) BUT execution pattern found = suspicious
  // This catches: echo "hidden payload" | bash
  if (contentWasStripped && categories.has("indirect_execution")) {
    baseScore += 30;
    factors.push("stripped_content_with_execution");
  }

  return {
    score: Math.min(100, Math.max(0, baseScore)),
    matches,
    factors,
  };
}

/**
 * Analyze a command for dangerous patterns
 */
export function analyzeCommand(
  command: string,
  options?: {
    config?: Partial<RubberBandConfig>;
  },
): RubberBandResult {
  const startTime = performance.now();
  const config = { ...DEFAULT_CONFIG, ...options?.config };

  // Check if disabled
  if (!config.enabled || config.mode === "off") {
    return { disposition: "ALLOW", score: 0, matches: [], factors: [] };
  }

  // Block excessively long commands (prevents ReDoS and hiding payloads)
  if (command.length > MAX_COMMAND_LENGTH) {
    logWarn(`rubberband: BLOCK (command exceeds ${MAX_COMMAND_LENGTH} chars: ${command.length})`);
    return {
      disposition: "BLOCK",
      score: 100,
      matches: [{ rule_id: "command_too_long", category: "evasion", score: 100 }],
      factors: [`length:${command.length}`],
    };
  }

  // Context-aware preprocessing - strip content that looks dangerous but isn't
  const [preprocessedCommand, contentWasStripped] = stripContextSafeContent(command);

  // Normalize to catch encoding bypasses
  const normalizedCommand = normalize(preprocessedCommand);

  // Calculate risk
  const risk = calculateRisk(normalizedCommand, config, contentWasStripped);

  // Determine disposition based on mode and score
  // Note: mode "off" returns early above, so only block/alert/log/shadow reach here
  let disposition: RubberBandDisposition;

  // "log" mode: always LOG (silent, no user notifications)
  if (config.mode === "log") {
    disposition = risk.score > 0 ? "LOG" : "ALLOW";
  }
  // "shadow" mode: LOG internally (no block, no user alerts)
  else if (config.mode === "shadow") {
    disposition = risk.score > 0 ? "LOG" : "ALLOW";
  }
  // "alert" and "block" modes: normal threshold-based disposition
  else if (risk.score >= config.thresholds.block) {
    disposition = config.mode === "block" ? "BLOCK" : "ALERT";
  } else if (risk.score >= config.thresholds.alert) {
    disposition = "ALERT";
  } else if (risk.score > 0) {
    disposition = "LOG";
  } else {
    disposition = "ALLOW";
  }

  const analyzeMs = performance.now() - startTime;

  // Log based on disposition
  const modeTag = config.mode === "shadow" ? " [SHADOW]" : "";
  if (disposition === "BLOCK") {
    logWarn(
      `rubberband:${modeTag} BLOCK (score=${risk.score}, ${analyzeMs.toFixed(1)}ms) ` +
        `command="${command.slice(0, 100)}" rules=[${risk.matches.map((m) => m.rule_id).join(",")}]`,
    );
  } else if (disposition === "ALERT" && risk.score > 0) {
    logInfo(
      `rubberband:${modeTag} ALERT (score=${risk.score}, ${analyzeMs.toFixed(1)}ms) ` +
        `command="${command.slice(0, 100)}" rules=[${risk.matches.map((m) => m.rule_id).join(",")}]`,
    );
  }

  // In shadow mode, never actually block
  if (config.mode === "shadow" && disposition === "BLOCK") {
    disposition = "ALERT";
  }

  return {
    disposition,
    score: risk.score,
    matches: risk.matches,
    factors: risk.factors,
  };
}
