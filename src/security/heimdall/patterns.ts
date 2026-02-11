/**
 * Heimdall Security Layer — Deployment-Specific Token Patterns
 *
 * Context-anchored patterns that require a keyword prefix to avoid
 * false positives on git SHA-1 hashes, MD5 checksums, etc.
 */

import type { OutputFilterPattern } from "./types.js";

export const DEPLOYMENT_PATTERNS: OutputFilterPattern[] = [
  {
    name: "Telegram Bot Token",
    // Format: <bot_id>:<base64_token> (e.g., 123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)
    regex: "\\b\\d{8,10}:[A-Za-z0-9_-]{35,}\\b",
    flags: "g",
  },
  {
    name: "Generic API Key Assignment",
    // Context-anchored: requires api_key=, api-key=, apikey=, or API_KEY= prefix
    regex: "(?:api[_-]?key|API[_-]?KEY)\\s*[=:]\\s*[\"']?([a-zA-Z0-9_\\-]{20,})[\"']?",
    flags: "gi",
  },
  {
    name: "Generic Secret Assignment",
    // Context-anchored: requires secret=, SECRET=, token=, TOKEN= prefix
    regex:
      "(?:secret|SECRET|token|TOKEN|password|PASSWORD)\\s*[=:]\\s*[\"']?([a-zA-Z0-9_\\-]{16,})[\"']?",
    flags: "gi",
  },
  {
    name: "Anthropic API Key",
    regex: "sk-ant-[a-zA-Z0-9_\\-]{20,}",
    flags: "g",
  },
  {
    name: "Slack Token",
    regex: "xox[bporas]-[a-zA-Z0-9\\-]{10,}",
    flags: "g",
  },
  {
    name: "Discord Bot Token",
    // Base64-encoded bot token: three dot-separated base64 segments
    regex: "[MN][A-Za-z0-9]{23,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}",
    flags: "g",
  },
  {
    name: "Google API Key",
    regex: "AIza[A-Za-z0-9_\\-]{35}",
    flags: "g",
  },
  {
    name: "Private Key Block",
    regex: "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    flags: "g",
  },
];
