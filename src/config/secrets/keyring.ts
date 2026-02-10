/**
 * OS Keyring secrets provider — cross-platform native credential storage.
 *
 * Supported platforms:
 * - **macOS**: Uses the `security` CLI with a dedicated OpenClaw keychain
 * - **Linux**: Uses `secret-tool` (libsecret / GNOME Keyring / KDE Wallet via D-Bus Secret Service API)
 * - **Windows**: Not yet implemented (Credential Manager). Contributions welcome.
 *
 * No external npm dependencies — uses platform-native CLIs only.
 */

import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SecretsProvider } from "./provider.js";
import { MissingSecretError } from "./errors.js";

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

  /**
   * Account/service name used for keyring items.
   * Defaults to "openclaw".
   * On macOS: used as the `-a` (account) parameter.
   * On Linux: used as the `service` attribute for secret-tool.
   */
  account?: string;
}

/**
 * Creates a platform-native keyring secrets provider.
 *
 * @example
 * ```json5
 * {
 *   "secrets": {
 *     "provider": "keyring"
 *     // Optional: "keyring": { "account": "openclaw" }
 *   },
 *   "channels": {
 *     "slack": { "botToken": "$secret{slack-bot-token}" }
 *   }
 * }
 * ```
 *
 * Setup (one-time):
 *
 * macOS:
 * ```bash
 * security create-keychain -p '' ~/Library/Keychains/openclaw.keychain-db
 * security add-generic-password -a openclaw -s slack-bot-token -w "xoxb-..." ~/Library/Keychains/openclaw.keychain-db
 * ```
 *
 * Linux:
 * ```bash
 * echo -n "xoxb-..." | secret-tool store --label="openclaw: slack-bot-token" service openclaw key slack-bot-token
 * ```
 */
export function createKeyringSecretsProvider(
  options: KeyringSecretsProviderOptions = {},
): SecretsProvider {
  const os = platform();
  const account = options.account ?? "openclaw";

  if (os === "darwin") {
    return createMacOSProvider(options, account);
  }

  if (os === "linux") {
    return createLinuxProvider(account);
  }

  return {
    name: "keyring",
    async resolve(_secretName: string): Promise<string> {
      throw new Error(
        `OS keyring secrets provider is not implemented for platform: ${os}. ` +
          `Supported: macOS (security CLI), Linux (secret-tool / libsecret). ` +
          `Contributions welcome for Windows (Credential Manager) — see src/config/secrets/keyring.ts`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// macOS implementation — uses `security` CLI with dedicated keychain
// ---------------------------------------------------------------------------

function createMacOSProvider(
  options: KeyringSecretsProviderOptions,
  account: string,
): SecretsProvider {
  const rawKeychainPath =
    options.keychainPath ?? path.join(homedir(), "Library", "Keychains", "openclaw.keychain-db");
  // Expand ~ to home directory so users can use ~/Library/... in config
  const keychainPath = rawKeychainPath.startsWith("~/")
    ? path.join(homedir(), rawKeychainPath.slice(2))
    : rawKeychainPath;
  const keychainPassword = options.keychainPassword ?? "";
  let unlocked = false;

  async function ensureUnlocked(): Promise<void> {
    if (unlocked) {
      return;
    }
    try {
      // Pass password via stdin to avoid exposing it in process arguments (ps aux).
      // The `security unlock-keychain` command reads from stdin when no -p flag is given.
      // execFile without a callback returns a ChildProcess with piped stdio by default.
      // Use a timeout to prevent hanging if the process prompts interactively.
      const UNLOCK_TIMEOUT_MS = 10_000;
      const child = execFile("security", ["unlock-keychain", keychainPath], {
        timeout: UNLOCK_TIMEOUT_MS,
      });
      if (child.stdin) {
        child.stdin.write(keychainPassword + "\n");
        child.stdin.end();
      }
      // Consume stdout/stderr to prevent buffer blocking
      child.stdout?.resume();
      child.stderr?.resume();
      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`security unlock-keychain exited with code ${code}`));
          }
        });
        child.on("error", reject);
      });
      unlocked = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to unlock keychain at ${keychainPath}: ${msg}. ` +
          `Make sure the keychain exists (security create-keychain -p '' ${keychainPath}) ` +
          `and the password is correct.`,
        { cause: err },
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
        return stdout.trimEnd();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("could not be found") || msg.includes("SecKeychainSearchCopyNext")) {
          throw new MissingSecretError(secretName, "keyring");
        }
        throw new Error(`Failed to retrieve secret "${secretName}" from keychain: ${msg}`, {
          cause: err,
        });
      }
    },

    async dispose(): Promise<void> {
      try {
        await execFileAsync("security", ["lock-keychain", keychainPath]);
      } catch {
        // Best effort
      }
      unlocked = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Linux implementation — uses `secret-tool` (libsecret / D-Bus Secret Service)
// ---------------------------------------------------------------------------

function createLinuxProvider(account: string): SecretsProvider {
  /** Check that secret-tool is available (cached after first call). */
  let checked = false;

  async function ensureSecretTool(): Promise<void> {
    if (checked) {
      return;
    }
    try {
      await execFileAsync("which", ["secret-tool"]);
      checked = true;
    } catch {
      throw new Error(
        `secret-tool not found. Install libsecret to use the keyring provider on Linux:\n` +
          `  Arch/CachyOS: sudo pacman -S libsecret\n` +
          `  Ubuntu/Debian: sudo apt install libsecret-tools\n` +
          `  Fedora: sudo dnf install libsecret`,
      );
    }
  }

  return {
    name: "keyring",

    async resolve(secretName: string): Promise<string> {
      await ensureSecretTool();
      try {
        const { stdout } = await execFileAsync("secret-tool", [
          "lookup",
          "service",
          account,
          "key",
          secretName,
        ]);
        const value = stdout.trimEnd();
        if (!value) {
          throw new Error("empty");
        }
        return value;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("empty") || msg.includes("exit code")) {
          throw new MissingSecretError(secretName, "keyring");
        }
        throw new Error(`Failed to retrieve secret "${secretName}" from keyring: ${msg}`, {
          cause: err,
        });
      }
    },

    async dispose(): Promise<void> {
      // No cleanup needed for libsecret — D-Bus handles lifecycle
    },
  };
}
