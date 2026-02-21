/**
 * Masked Secrets — Command Preflight Checks
 *
 * Before a shell command executes, the preflight checker:
 * 1. Blocks commands that dump environment variables (env, printenv, export, set)
 * 2. Blocks direct reads of known secret files (cat .env, less credentials.json)
 * 3. Blocks echo/printf of env vars that are masked ($SECRET, ${SECRET})
 * 4. Substitutes {{secret:NAME}} references with real values
 * 5. Returns the processed command or a rejection
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SecretStore } from "./secret-store.js";
import { substituteSecrets } from "./substitution.js";
import type { PreflightResult } from "./types.js";

const log = createSubsystemLogger("security/masked-secrets");

/**
 * Patterns that match commands which dump the full environment.
 * These are blocked entirely — there's no safe way to filter them.
 */
const ENV_DUMP_PATTERNS: RegExp[] = [
  // Standalone env/printenv/set/export commands
  /^\s*(env|printenv)\s*$/,
  /^\s*set\s*$/,
  /^\s*export\s+-p\s*$/,
  /^\s*export\s*$/,
  // Python/Node/Ruby one-liners that print env
  /\bos\.environ\b/,
  /\bprocess\.env\b/,
];

/**
 * Patterns matching commands that try to read/echo specific secret env vars.
 * e.g., "echo $MY_API_KEY", "printf '%s' ${SECRET}"
 */
function buildEnvEchoPattern(secretNames: string[]): RegExp | null {
  if (secretNames.length === 0) {
    return null;
  }
  const names = secretNames.map((n) => escapeRegex(n)).join("|");
  // Match: echo $NAME, echo ${NAME}, printf ... $NAME, etc.
  return new RegExp(`\\$\\{?(${names})\\}?`, "g");
}

/**
 * Patterns matching direct reads of secret files.
 * e.g., "cat .env", "less ~/.openclaw/.env", "head credentials.json"
 */
const FILE_READ_COMMANDS = [
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "bat",
  "view",
  "vim",
  "nano",
  "code",
];

function isSecretFileRead(command: string, secretFilePaths: string[]): boolean {
  const lowerCmd = command.toLowerCase().trim();

  for (const readCmd of FILE_READ_COMMANDS) {
    if (!lowerCmd.startsWith(readCmd)) {
      continue;
    }

    for (const secretPath of secretFilePaths) {
      // Handle glob patterns
      if (secretPath.includes("*")) {
        const regex = new RegExp(secretPath.replace(/\./g, "\\.").replace(/\*/g, ".*"));
        if (regex.test(lowerCmd)) {
          return true;
        }
      } else if (lowerCmd.includes(secretPath.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Run preflight checks on a command before execution.
 * Returns whether the command is allowed and the processed command.
 */
export function preflightCheck(command: string, store: SecretStore): PreflightResult {
  const config = store.getConfig();
  const warnings: string[] = [];

  // Check 1: Block env dump commands
  for (const pattern of ENV_DUMP_PATTERNS) {
    if (pattern.test(command)) {
      log.warn(`Blocked env dump command: ${command.slice(0, 80)}`);
      return {
        allowed: false,
        reason:
          "This command would expose environment variables containing secrets. " +
          "Use {{secret:NAME}} to reference secrets in your commands instead.",
      };
    }
  }

  // Check 2: Block reading of secret files
  if (config.blockSecretFileReads) {
    if (isSecretFileRead(command, config.secretFilePaths ?? [])) {
      log.warn(`Blocked secret file read: ${command.slice(0, 80)}`);
      return {
        allowed: false,
        reason:
          "This file contains secrets and cannot be read directly. " +
          "Use {{secret:NAME}} to reference specific secrets.",
      };
    }
  }

  // Check 3: Detect and warn about $SECRET references
  const echoPattern = buildEnvEchoPattern(store.listNames());
  if (echoPattern && echoPattern.test(command)) {
    // Don't block, but warn — the env var might be filtered by the shell
    // or the agent might be doing something legitimate
    warnings.push(
      "Command references masked environment variables directly. " +
        "Consider using {{secret:NAME}} syntax instead for better security.",
    );
    log.warn(`Command references masked env vars: ${command.slice(0, 80)}`);
  }

  // Check 4: Substitute {{secret:NAME}} references
  const { text: processedCommand, substituted, missing } = substituteSecrets(command, store);

  if (missing.length > 0) {
    warnings.push(
      `Unknown secret reference(s): ${missing.join(", ")}. ` +
        `Available secrets: ${store.listNames().join(", ")}`,
    );
  }

  if (substituted.length > 0) {
    log.info(`Substituted ${substituted.length} secret(s) in command: ${substituted.join(", ")}`);
  }

  return {
    allowed: true,
    processedCommand,
    warnings,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
