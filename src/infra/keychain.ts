/**
 * OS Keychain integration for OpenClaw device credentials (VD-3).
 *
 * Stores Ed25519 private keys in the OS keychain when available:
 * - Linux: libsecret via `secret-tool` CLI
 * - macOS: Keychain Services via `security` CLI
 *
 * Activated by setting OPENCLAW_KEYCHAIN=1 in the environment.
 * Falls back transparently to file-based storage when keychain is unavailable.
 *
 * Usage:
 *   OPENCLAW_KEYCHAIN=1 openclaw gateway run
 *
 * Setup (Linux/headless):
 *   # Start gnome-keyring in headless mode
 *   eval $(gnome-keyring-daemon --start --components=secrets)
 *   export DBUS_SESSION_BUS_ADDRESS
 *   # Then set env var for openclaw
 *   OPENCLAW_KEYCHAIN=1 openclaw gateway run
 *
 * Setup (macOS):
 *   # No additional setup needed — macOS Keychain is always available
 *   OPENCLAW_KEYCHAIN=1 openclaw gateway run
 */

import { execSync } from "node:child_process";
import os from "node:os";

export interface KeychainProvider {
  readonly name: string;
  /** Whether this keychain is currently accessible */
  available(): boolean;
  /** Store a secret by key name */
  store(key: string, value: string): void;
  /** Retrieve a secret by key name. Returns null if not found. */
  retrieve(key: string): string | null;
  /** Delete a secret by key name */
  delete(key: string): void;
}

// ── Linux: libsecret via secret-tool CLI ─────────────────────────────────────

class SecretToolKeychain implements KeychainProvider {
  readonly name = "libsecret (secret-tool)";

  available(): boolean {
    try {
      execSync("secret-tool --version", { stdio: "pipe", timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  store(key: string, value: string): void {
    execSync(
      `secret-tool store --label "OpenClaw ${key}" service openclaw key ${JSON.stringify(key)}`,
      { input: value, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    );
  }

  retrieve(key: string): string | null {
    try {
      const result = execSync(`secret-tool lookup service openclaw key ${JSON.stringify(key)}`, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      const value = result.toString("utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }

  delete(key: string): void {
    try {
      execSync(`secret-tool clear service openclaw key ${JSON.stringify(key)}`, {
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Ignore errors if key doesn't exist
    }
  }
}

// ── macOS: Keychain Services via `security` CLI ───────────────────────────────

class MacOSKeychain implements KeychainProvider {
  readonly name = "macOS Keychain";

  available(): boolean {
    return os.platform() === "darwin";
  }

  store(key: string, value: string): void {
    // Delete first to allow update (security add-generic-password fails if exists)
    this.delete(key);
    execSync(
      `security add-generic-password -a openclaw -s ${JSON.stringify(key)} -w ${JSON.stringify(value)}`,
      { stdio: "pipe", timeout: 5000 },
    );
  }

  retrieve(key: string): string | null {
    try {
      const result = execSync(
        `security find-generic-password -a openclaw -s ${JSON.stringify(key)} -w`,
        { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      );
      const value = result.toString("utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }

  delete(key: string): void {
    try {
      execSync(`security delete-generic-password -a openclaw -s ${JSON.stringify(key)}`, {
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Ignore errors if key doesn't exist
    }
  }
}

// ── Provider resolution ───────────────────────────────────────────────────────

let _resolved: KeychainProvider | null | undefined = undefined;

/**
 * Resolve the appropriate keychain provider for the current platform.
 * Returns null if no keychain is available.
 */
export function resolveKeychainProvider(): KeychainProvider | null {
  if (_resolved !== undefined) {
    return _resolved;
  }

  const candidates: KeychainProvider[] =
    os.platform() === "darwin" ? [new MacOSKeychain()] : [new SecretToolKeychain()];

  for (const candidate of candidates) {
    if (candidate.available()) {
      _resolved = candidate;
      return _resolved;
    }
  }

  _resolved = null;
  return null;
}

/**
 * Whether keychain storage is enabled via OPENCLAW_KEYCHAIN=1 env var.
 */
export function isKeychainEnabled(): boolean {
  return process.env.OPENCLAW_KEYCHAIN === "1";
}

/**
 * Store a secret in the OS keychain.
 * Returns true on success, false if keychain is unavailable or disabled.
 */
export function storeInKeychain(key: string, value: string): boolean {
  if (!isKeychainEnabled()) {
    return false;
  }
  const provider = resolveKeychainProvider();
  if (!provider) {
    return false;
  }
  try {
    provider.store(key, value);
    return true;
  } catch (err) {
    console.warn(`[keychain] Failed to store "${key}": ${err}`);
    return false;
  }
}

/**
 * Retrieve a secret from the OS keychain.
 * Returns null if keychain is disabled, unavailable, or key not found.
 */
export function retrieveFromKeychain(key: string): string | null {
  if (!isKeychainEnabled()) {
    return null;
  }
  const provider = resolveKeychainProvider();
  if (!provider) {
    return null;
  }
  try {
    return provider.retrieve(key);
  } catch (err) {
    console.warn(`[keychain] Failed to retrieve "${key}": ${err}`);
    return null;
  }
}
