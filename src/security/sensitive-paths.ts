import os from "node:os";
import path from "node:path";

/**
 * Denylist of filesystem paths that should never be read by agent tools,
 * even when `tools.fs.workspaceOnly` is disabled.
 *
 * These paths typically contain secrets, credentials, or private keys that
 * could be leaked via indirect prompt injection if the agent is tricked
 * into reading and returning their contents.
 */

const HOME = os.homedir();

const SENSITIVE_PATH_PREFIXES: string[] = [
  // SSH keys and config
  path.join(HOME, ".ssh"),
  // AWS credentials
  path.join(HOME, ".aws"),
  // GCP credentials
  path.join(HOME, ".config", "gcloud"),
  // Azure credentials
  path.join(HOME, ".azure"),
  // GPG keys
  path.join(HOME, ".gnupg"),
  // Docker credentials
  path.join(HOME, ".docker", "config.json"),
  // Kubernetes credentials
  path.join(HOME, ".kube", "config"),
  // OpenClaw credentials
  path.join(HOME, ".openclaw", "credentials"),
  // npm auth tokens
  path.join(HOME, ".npmrc"),
  // Generic dotenv files
  path.join(HOME, ".env"),
  // 1Password CLI config
  path.join(HOME, ".config", "op"),
  // System shadow/passwd
  "/etc/shadow",
  "/etc/master.passwd",
  // macOS Keychain
  path.join(HOME, "Library", "Keychains"),
];

const SENSITIVE_FILENAME_PATTERNS: RegExp[] = [
  // Private keys
  /id_(?:rsa|ed25519|ecdsa|dsa)$/,
  // Generic key files
  /\.pem$/,
  /\.key$/,
  // Environment files with secrets
  /^\.env(?:\..+)?$/,
  // Token/credential files
  /credentials\.json$/,
  /token\.json$/,
  /service[_-]?account.*\.json$/,
];

/**
 * Returns true if the given absolute path points to a sensitive location
 * that should be blocked from agent file reads.
 */
export function isSensitivePath(absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);

  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`)) {
      return true;
    }
  }

  const basename = path.basename(resolved);
  for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns a human-readable reason why the path is blocked, or undefined if it is not sensitive.
 */
export function sensitivePathReason(absolutePath: string): string | undefined {
  if (!isSensitivePath(absolutePath)) {
    return undefined;
  }
  return `Access denied: "${absolutePath}" is in a sensitive location that may contain secrets or credentials. This restriction protects against indirect prompt injection attacks that could leak host secrets.`;
}
