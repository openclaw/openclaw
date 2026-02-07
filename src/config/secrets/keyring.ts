/**
 * OS Keyring / macOS Keychain provider.
 *
 * Uses the macOS `security` CLI to store and retrieve secrets from a dedicated
 * OpenClaw keychain. On other platforms, falls back to a "not implemented" error
 * with guidance on what's needed.
 *
 * macOS implementation:
 * - Uses a dedicated keychain file (`~/Library/Keychains/openclaw.keychain-db`)
 * - Secrets stored as generic password items with account="openclaw"
 * - Keychain must be unlocked before use (password defaults to empty string)
 *
 * Linux/Windows: not yet implemented. Contributions welcome.
 * Potential approaches: libsecret (Linux), Windows Credential Manager, or `keytar` npm package.
 */

import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SecretsProvider } from "./provider.js";

const execFileAsync = promisify(execFile);

/** Options for the keyring secrets provider. */
export interface KeyringSecretsProviderOptions {
  /**
   * Path to the keychain file (macOS only).
   * Defaults to `~/Library/Keychains/openclaw.keychain-db`.
   */
  keychainPath?: string;

  /**
   * Password to unlock the keychain (macOS only).
   * Defaults to empty string (matching the default created by setup).
   */
  keychainPassword?: string;

  /** Account name used for keychain items. Defaults to "openclaw". */
  account?: string;
}

/**
 * Creates a macOS Keychain secrets provider.
 *
 * Resolves secrets by looking up generic password items in the OpenClaw keychain
 * using the `security` CLI.
 *
 * @example
 * ```json5
 * {
 *   "secrets": {
 *     "provider": "keyring",
 *     "keyring": { "keychainPath": "~/Library/Keychains/openclaw.keychain-db" }
 *   },
 *   "channels": {
 *     "slack": { "botToken": "$secret{slack-bot-token}" }
 *   }
 * }
 * ```
 */
export function createKeyringSecretsProvider(
  options: KeyringSecretsProviderOptions = {},
): SecretsProvider {
  const os = platform();

  if (os !== "darwin") {
    return {
      name: "keyring",
      async resolve(_secretName: string): Promise<string> {
        throw new Error(
          `OS keyring secrets provider is only implemented for macOS (darwin). ` +
            `Current platform: ${os}. ` +
            `Contributions welcome for Linux (libsecret) and Windows (Credential Manager) — ` +
            `see src/config/secrets/keyring.ts`,
        );
      },
    };
  }

  const account = options.account ?? "openclaw";
  const keychainPath =
    options.keychainPath ?? path.join(homedir(), "Library", "Keychains", "openclaw.keychain-db");
  const keychainPassword = options.keychainPassword ?? "";

  let unlocked = false;

  async function ensureUnlocked(): Promise<void> {
    if (unlocked) return;
    try {
      await execFileAsync("security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
      unlocked = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to unlock keychain at ${keychainPath}: ${msg}. ` +
          `Make sure the keychain exists (security create-keychain -p '' ${keychainPath}) ` +
          `and the password is correct.`,
      );
    }
  }

  return {
    name: "keyring",

    async resolve(secretName: string): Promise<string> {
      await ensureUnlocked();

      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-a",
          account,
          "-s",
          secretName,
          "-w",
          keychainPath,
        ]);
        // stdout includes a trailing newline
        return stdout.trimEnd();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("could not be found") || msg.includes("SecKeychainSearchCopyNext")) {
          throw new Error(
            `Secret "${secretName}" not found in keychain at ${keychainPath}. ` +
              `Add it with: security add-generic-password -a ${account} -s ${secretName} -w "VALUE" ${keychainPath}`,
          );
        }
        throw new Error(`Failed to retrieve secret "${secretName}" from keychain: ${msg}`);
      }
    },

    async dispose(): Promise<void> {
      // Lock the keychain when done (security best practice)
      try {
        await execFileAsync("security", ["lock-keychain", keychainPath]);
      } catch {
        // Best effort — don't throw on cleanup
      }
      unlocked = false;
    },
  };
}
