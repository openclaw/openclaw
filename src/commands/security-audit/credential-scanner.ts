import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SecurityFinding, SecuritySeverity } from "./types.js";

export const SECRET_PATTERNS: Array<{
  id: string;
  name: string;
  pattern: RegExp;
  severity: SecuritySeverity;
  remediation: string;
}> = [
  {
    id: "cred:openai-key",
    name: "OpenAI API key",
    pattern: /\bsk-[a-zA-Z0-9]{20,48}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded key and use SecretRef or environment variables.",
  },
  {
    id: "cred:github-token",
    name: "GitHub personal access token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded token and use SecretRef or environment variables.",
  },
  {
    id: "cred:telegram-bot-token",
    name: "Telegram bot token",
    pattern: /\b[0-9]{8,10}:[a-zA-Z0-9_-]{35}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded token and use SecretRef or environment variables.",
  },
  {
    id: "cred:nvidia-api-key",
    name: "NVIDIA API key",
    pattern: /\bnvapi-[a-zA-Z0-9]{32,64}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded key and use SecretRef or environment variables.",
  },
  {
    id: "cred:private-key-hex",
    name: "Ethereum private key (hex)",
    pattern: /\b0x[a-fA-F0-9]{64}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded private key and use a secure vault or hardware wallet.",
  },
  {
    id: "cred:db-connection-string",
    name: "Database connection string",
    pattern: /(mongodb\+srv|postgres|mysql|redis):\/\/[^\s\"']+/i,
    severity: "HIGH",
    remediation:
      "Remove the hardcoded connection string and use SecretRef or environment variables.",
  },
  {
    id: "cred:aws-access-key",
    name: "AWS access key ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    severity: "CRITICAL",
    remediation: "Remove the hardcoded key and use IAM roles or SecretRef.",
  },
  {
    id: "cred:generic-api-key",
    name: "Generic API key pattern",
    pattern: /\b(api[_-]?key|apikey|api_token)[\s]*[=:]+[\s]*["']?[a-zA-Z0-9_\-]{16,}["']?/i,
    severity: "MEDIUM",
    remediation: "Review and remove if this is a real credential. Use SecretRef if needed.",
  },
  {
    id: "cred:password-plaintext",
    name: "Plaintext password",
    pattern: /\b(password|passwd|pwd)[\s]*[=:]+[\s]*["'][^"']{4,}["']/i,
    severity: "HIGH",
    remediation: "Remove the plaintext password and use SecretRef or a password manager.",
  },
];

const SCAN_PATHS = [
  ".openclaw",
  ".openclaw/agents",
  ".openclaw/credentials",
  ".openclaw/signals",
  ".ssh",
];

const EXCLUDED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".mp3",
  ".mp4",
  ".zip",
  ".tar",
  ".gz",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".bin",
  ".o",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".node",
]);

const EXCLUDED_FILES = new Set([
  ".gitignore",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

async function* walkFiles(dir: string, baseDir: string): AsyncGenerator<string> {
  const { readdir, stat } = await import("node:fs/promises");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        yield* walkFiles(fullPath, baseDir);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXCLUDED_EXTENSIONS.has(ext)) {
          continue;
        }
        if (EXCLUDED_FILES.has(entry.name)) {
          continue;
        }
        yield fullPath;
      }
    }
  } catch {
    // Permission denied or other errors — skip
  }
}

export async function scanCredentials(homeDir: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  for (const relativePath of SCAN_PATHS) {
    const scanDir = path.join(homeDir, relativePath);
    for await (const filePath of walkFiles(scanDir, homeDir)) {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        const relativeFilePath = path.relative(homeDir, filePath);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          for (const secret of SECRET_PATTERNS) {
            if (secret.pattern.test(line)) {
              findings.push({
                id: secret.id,
                severity: secret.severity,
                category: "credential",
                message: `Possible ${secret.name} exposed in file`,
                file: relativeFilePath,
                line: lineIndex + 1,
                remediation: secret.remediation,
              });
            }
          }
        }
      } catch {
        // Skip files we can't read
      }
    }
  }

  return findings;
}
