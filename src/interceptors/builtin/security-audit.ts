/**
 * Security audit interceptor.
 * Blocks read/write access to sensitive files and paths.
 */

import type { InterceptorRegistration } from "../types.js";

// Paths containing these substrings are blocked
const BLOCKED_PATH_PATTERNS: string[] = [
  // User secrets
  ".aws/",
  ".gnupg/",
  ".password-store/",
  // SSH private keys
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  // System paths
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  // Certificate/key files
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  // Environment files
  "/.env",
  // Cloud credentials
  "credentials.json",
  "service-account.json",
  ".boto",
  "kubeconfig",
  // Claude Code auth
  ".claude/.credentials.json",
  ".claude/credentials/",
  // OpenClaw / Clawdbot auth
  ".openclaw/credentials/",
  ".clawdbot/credentials/",
  "auth-profiles.json",
  // OpenAI Codex auth
  ".codex/auth.json",
  // Qwen / MiniMax portal OAuth
  ".qwen/oauth_creds.json",
  ".minimax/oauth_creds.json",
  // Google CLI OAuth
  "gogcli/credentials.json",
  // WhatsApp session creds
  "whatsapp/default/creds.json",
  // GitHub Copilot tokens
  "github-copilot.token.json",
  // Shell profile files (may export API keys)
  "/.profile",
  "/.bash_profile",
  "/.bashrc",
  "/.zshrc",
  "/.zprofile",
  "/.config/fish/config.fish",
];

// Allow-list: paths that contain a blocked substring but are actually safe
const ALLOWED_EXCEPTIONS: RegExp[] = [
  // .pem/.key in node_modules, docs, or test fixtures are fine
  /node_modules\//,
  /\.test\./,
  /\/test\//,
  /\/fixtures\//,
  // package-lock.json contains "credentials.json" as a string sometimes
  /package-lock\.json$/,
];

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();

  // Check allow-list exceptions first
  for (const exception of ALLOWED_EXCEPTIONS) {
    if (exception.test(normalized)) {
      return false;
    }
  }

  for (const blocked of BLOCKED_PATH_PATTERNS) {
    if (normalized.includes(blocked.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export function createSecurityAudit(): InterceptorRegistration<"tool.before"> {
  return {
    id: "builtin:security-audit",
    name: "tool.before",
    priority: 99, // high priority, just below command-safety-guard
    toolMatcher: /^(read|write|edit)$/,
    handler: (_input, output) => {
      const raw = output.args.file_path ?? output.args.path;
      const filePath = typeof raw === "string" ? raw : "";
      if (filePath && isSensitivePath(filePath)) {
        output.block = true;
        output.blockReason = `Access denied: "${filePath}" contains sensitive data`;
      }
    },
  };
}
