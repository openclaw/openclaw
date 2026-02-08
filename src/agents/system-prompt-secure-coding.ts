/**
 * Build secure coding guidelines section for the system prompt.
 * This section provides security best practices for code generation.
 * Covers OWASP Top 10 and common vulnerability patterns.
 */
export function buildSecureCodingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  secureCodingEnabled?: boolean;
}): string[] {
  // Skip for minimal mode (subagents handle their own security)
  if (params.isMinimal) {
    return [];
  }

  // Check if coding-related tools are available
  const hasCodingTools =
    params.availableTools.has("write") ||
    params.availableTools.has("edit") ||
    params.availableTools.has("exec") ||
    params.availableTools.has("apply_patch");

  // Only include if coding tools are available and not explicitly disabled
  if (!hasCodingTools || params.secureCodingEnabled === false) {
    return [];
  }

  return [
    "## Secure Coding Practices",
    "When writing or modifying code, follow these security best practices:",
    "",
    "**Credentials & Secrets:**",
    "- NEVER hardcode API keys, tokens, passwords, or secrets in source code",
    "- Use secret managers (Vault, AWS Secrets Manager) in production; .env files only for local dev",
    "- Ensure .env files are in .gitignore and never committed",
    "- Set file permissions to 0600 for credential files (where supported by OS)",
    "- Check for accidentally committed secrets before pushing",
    "",
    "**Input Validation & Injection Prevention:**",
    "- Validate and sanitize ALL user inputs before processing",
    "- Use parameterized queries to prevent SQL injection",
    "- Escape output appropriately to prevent XSS (HTML, JS, URL contexts)",
    "- Avoid shell command construction from user input; use safe APIs instead",
    "- When exec is necessary, use allowlists and escape/quote arguments properly",
    "",
    "**Authentication & Access Control:**",
    "- Implement proper authentication checks on all protected endpoints",
    "- Use established auth libraries (passport, next-auth, etc.) — don't roll your own",
    "- Check authorization for every resource access (prevent IDOR)",
    "- Use secure session management with proper timeouts",
    "- Implement CSRF protection for state-changing operations",
    "",
    "**Cryptography:**",
    "- Use established crypto libraries — never implement your own",
    "- Use strong algorithms (AES-256-GCM, bcrypt/argon2 for passwords)",
    "- Generate cryptographically secure random values (crypto.randomBytes, not Math.random)",
    "- Never use MD5 or SHA1 for security purposes",
    "",
    "**Dependencies:**",
    "- Use lockfiles (package-lock.json, pnpm-lock.yaml) for reproducible builds",
    "- Run `npm audit` / `pip-audit` / equivalent before committing",
    "- Prefer well-maintained packages with active security practices",
    "- Keep dependencies updated — pinning without updates freezes vulnerabilities",
    "",
    "**File & Network Operations:**",
    "- Validate file paths to prevent path traversal (../) attacks",
    "- Validate URLs to prevent SSRF — use allowlists for external requests",
    "- Validate file uploads: check type, size, and sanitize filenames",
    "- Use restrictive permissions (0600 secrets, 0700 sensitive dirs)",
    "",
    "**Error Handling & Logging:**",
    "- Never expose stack traces or internal errors to end users",
    "- Log security events (auth failures, access denials) for monitoring",
    "- Never log sensitive data (passwords, tokens, PII)",
    "- Fail securely — deny by default on auth/permission errors",
    "",
    "**Before Committing:**",
    "- Review diff for accidental secret exposure",
    "- Ensure no debug code, backdoors, or test credentials remain",
    "- Verify tests pass and no security warnings are ignored",
    "",
  ];
}
