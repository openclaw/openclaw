/**
 * OS Keyring secrets provider — cross-platform native credential storage.
 *
 * Supported platforms:
 * - **macOS**: Uses the `security` CLI with a dedicated OpenClaw keychain
 * - **Linux**: Uses `secret-tool` (libsecret / GNOME Keyring / KDE Wallet via D-Bus Secret Service API)
 * - **Windows**: Not yet implemented (Credential Manager). Contributions welcome.
 *
 * No external npm dependencies — uses platform-native CLIs only.
 *
 * Config example:
 * ```json
 * { "secrets": { "providers": { "keyring": { "account": "openclaw" } } } }
 * ```
 *
 * Usage: `${keyring:slack-bot-token}` resolves via OS keyring.
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

import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SecretProvider } from "./secret-resolution.js";

const execFileAsync = promisify(execFile);

export interface KeyringProviderConfig {
  /** Account/service name for keyring items. Defaults to "openclaw". */
  account?: string;
  /** Path to the keychain file (macOS only). */
  keychainPath?: string;
  /** Password to unlock the keychain (macOS only). Defaults to "". */
  keychainPassword?: string;
}

export class KeyringSecretProvider implements SecretProvider {
  public readonly name = "keyring";
  private readonly account: string;
  private readonly os: NodeJS.Platform;
  // macOS-specific
  private readonly keychainPath: string;
  private readonly keychainPassword: string;
  private macUnlocked = false;
  // Linux-specific
  private linuxChecked = false;

  constructor(config: KeyringProviderConfig = {}) {
    this.account = config.account ?? "openclaw";
    this.os = platform();
    this.keychainPath =
      config.keychainPath ?? path.join(homedir(), "Library", "Keychains", "openclaw.keychain-db");
    this.keychainPassword = config.keychainPassword ?? "";
  }

  async getSecret(name: string, _version?: string): Promise<string> {
    if (this.os === "darwin") {
      return this.macGetSecret(name);
    }
    if (this.os === "linux") {
      return this.linuxGetSecret(name);
    }
    throw new Error(
      `Keyring provider is not implemented for platform: ${this.os}. ` +
        `Supported: macOS (security CLI), Linux (secret-tool / libsecret).`,
    );
  }

  async setSecret(_name: string, _value: string): Promise<void> {
    throw new Error("KeyringSecretProvider.setSecret is not yet implemented");
  }

  async listSecrets(): Promise<string[]> {
    throw new Error("KeyringSecretProvider.listSecrets is not yet implemented");
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.os === "darwin") {
        await execFileAsync("security", ["show-keychain-info", this.keychainPath]);
        return { ok: true };
      }
      if (this.os === "linux") {
        await execFileAsync("which", ["secret-tool"]);
        return { ok: true };
      }
      return { ok: false, error: `Unsupported platform: ${this.os}` };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // macOS — `security` CLI
  // ---------------------------------------------------------------------------

  private async macEnsureUnlocked(): Promise<void> {
    if (this.macUnlocked) {
      return;
    }

    const UNLOCK_TIMEOUT_MS = 10_000;
    const child = execFile("security", ["unlock-keychain", this.keychainPath], {
      timeout: UNLOCK_TIMEOUT_MS,
    });
    if (child.stdin) {
      child.stdin.write(this.keychainPassword + "\n");
      child.stdin.end();
    }
    child.stdout?.resume();
    child.stderr?.resume();

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`security unlock-keychain exited with code ${code}`)),
      );
      child.on("error", reject);
    });
    this.macUnlocked = true;
  }

  private async macGetSecret(name: string): Promise<string> {
    await this.macEnsureUnlocked();
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        name,
        "-w",
        this.keychainPath,
      ]);
      return stdout.trimEnd();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("could not be found") || msg.includes("SecKeychainSearchCopyNext")) {
        throw new Error(`Secret "${name}" not found in macOS keychain`, { cause: err });
      }
      throw new Error(`Failed to retrieve secret "${name}" from keychain: ${msg}`, { cause: err });
    }
  }

  // ---------------------------------------------------------------------------
  // Linux — `secret-tool` (libsecret)
  // ---------------------------------------------------------------------------

  private async linuxEnsureSecretTool(): Promise<void> {
    if (this.linuxChecked) {
      return;
    }
    try {
      await execFileAsync("which", ["secret-tool"]);
      this.linuxChecked = true;
    } catch {
      throw new Error(
        `secret-tool not found. Install libsecret to use the keyring provider on Linux:\n` +
          `  Arch/CachyOS: sudo pacman -S libsecret\n` +
          `  Ubuntu/Debian: sudo apt install libsecret-tools\n` +
          `  Fedora: sudo dnf install libsecret`,
      );
    }
  }

  private async linuxGetSecret(name: string): Promise<string> {
    await this.linuxEnsureSecretTool();
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service",
        this.account,
        "key",
        name,
      ]);
      const value = stdout.trimEnd();
      if (!value) {
        throw new Error(`Secret "${name}" not found in keyring`);
      }
      return value;
    } catch {
      throw new Error(`Secret "${name}" not found in keyring`);
    }
  }
}
