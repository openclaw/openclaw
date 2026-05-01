/**
 * Sensitive information regex rules for outbound security fast-scan.
 */

export interface Finding {
  type: string;
  value: string;
  fullValue: string;
  risk: "high" | "medium" | "low";
}

const SENSITIVE_PATTERNS: Array<[RegExp, string, "high" | "medium" | "low"]> = [
  // Cloud Provider Keys
  [/AKIA[0-9A-Z]{16}/g, "AWS Access Key", "high"],
  [/(?:aws_secret|aws_access)[_\w]*\s*[=:]\s*\S+/gi, "AWS Credentials", "high"],
  [/LTAI[a-zA-Z0-9]{12,20}/g, "Aliyun AccessKey", "high"],
  [/(?:azure|subscription)[_\w]*key\s*[=:]\s*\S+/gi, "Azure Key", "high"],

  // API Keys / Tokens
  [/sk-[a-zA-Z0-9]{20,}/g, "OpenAI API Key", "high"],
  [/ghp_[a-zA-Z0-9]{36}/g, "GitHub PAT", "high"],
  [/gho_[a-zA-Z0-9]{36}/g, "GitHub OAuth Token", "high"],
  [/glpat-[a-zA-Z0-9-]{20,}/g, "GitLab PAT", "high"],
  [/xoxb-[a-zA-Z0-9-]+/g, "Slack Bot Token", "high"],
  [/xoxp-[a-zA-Z0-9-]+/g, "Slack User Token", "high"],

  // General Password / Secret fields
  [
    /(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|auth_?key|secret_?key)\s*[=:]\s*\S+/gi,
    "General Password/Key",
    "high",
  ],

  // DB Connection strings
  [
    /(?:mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/\S+:\S+@\S+/gi,
    "DB Connection String",
    "high",
  ],
  [/jdbc:\w+:\/\/\S+/gi, "JDBC Connection String", "high"],

  // Private Keys
  [
    /-----BEGIN\s+(?:RSA |EC |DSA |ED25519 )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |EC |DSA |ED25519 )?PRIVATE KEY-----/g,
    "Private Key",
    "high",
  ],
  [
    /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
    "SSH Private Key",
    "high",
  ],
  [
    /-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----[\s\S]*?-----END\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/g,
    "PGP Private Key",
    "high",
  ],

  // Bearer Token
  [/Authorization:\s*Bearer\s+\S+/gi, "Bearer Token", "high"],
  [/Authorization:\s*Basic\s+\S+/gi, "Basic Auth", "medium"],

  // IPv4 + Port (Internal networks typically)
  [
    /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d{2,5}/g,
    "Internal IP + Port",
    "medium",
  ],
  [
    /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    "Internal IP",
    "low",
  ],
];

function deduplicate(findings: Finding[]): Finding[] {
  if (findings.length <= 1) {
    return findings;
  }

  // Sort by length descending to keep the longest substring if overlaps occur
  const sorted = [...findings].toSorted((a, b) => b.fullValue.length - a.fullValue.length);
  const result: Finding[] = [];

  for (const item of sorted) {
    const isSubstring = result.some((existing) => existing.fullValue.includes(item.fullValue));
    if (!isSubstring) {
      result.push(item);
    }
  }

  return result;
}

export function scanSensitive(text: string): Finding[] {
  let findings: Finding[] = [];
  const lines = text.split("\n");

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line) {
      continue;
    }

    for (const [pattern, label, risk] of SENSITIVE_PATTERNS) {
      // Reset lastIndex because we're using global flag
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const fullValue = match[0];
        const displayValue = fullValue.length > 20 ? fullValue.slice(0, 20) + "..." : fullValue;
        findings.push({
          type: label,
          value: displayValue,
          fullValue,
          risk,
        });
      }
    }
  }

  return deduplicate(findings);
}
