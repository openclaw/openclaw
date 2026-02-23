import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { VAULT_KEYCHAIN_SERVICE } from "./types.js";

function execPromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function accountForStateDir(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
}

// ── macOS Keychain via `security` CLI ───────────────────────────────

async function macKeychainAvailable(): Promise<boolean> {
  try {
    await execPromise("security", ["list-keychains"]);
    return true;
  } catch {
    return false;
  }
}

async function macKeychainGet(service: string, account: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execPromise("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    const hex = stdout.trim();
    if (!hex) {
      return null;
    }
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

async function macKeychainSet(service: string, account: string, key: Buffer): Promise<void> {
  const hex = key.toString("hex");
  try {
    await execPromise("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
      hex,
      "-U",
    ]);
  } catch {
    // -U flag updates if exists; some older macOS versions need delete-then-add
    try {
      await execPromise("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch {
      // ignore delete failure
    }
    await execPromise("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
      hex,
    ]);
  }
}

async function macKeychainDelete(service: string, account: string): Promise<void> {
  try {
    await execPromise("security", ["delete-generic-password", "-s", service, "-a", account]);
  } catch {
    // ignore if not found
  }
}

// ── Linux keychain via `secret-tool` (libsecret) ───────────────────

async function linuxKeychainAvailable(): Promise<boolean> {
  try {
    await execPromise("secret-tool", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function linuxKeychainGet(service: string, account: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execPromise("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      account,
    ]);
    const hex = stdout.trim();
    if (!hex) {
      return null;
    }
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

async function linuxKeychainSet(service: string, account: string, key: Buffer): Promise<void> {
  const hex = key.toString("hex");
  // secret-tool store reads the secret from stdin
  await new Promise<void>((resolve, reject) => {
    const proc = execFile(
      "secret-tool",
      ["store", "--label", `OpenClaw Vault (${account})`, "service", service, "account", account],
      { timeout: 10_000 },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
    proc.stdin?.end(hex);
  });
}

async function linuxKeychainDelete(service: string, account: string): Promise<void> {
  try {
    await execPromise("secret-tool", ["clear", "service", service, "account", account]);
  } catch {
    // ignore if not found
  }
}

// ── Platform dispatch ───────────────────────────────────────────────

export async function keychainAvailable(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "darwin") {
    return macKeychainAvailable();
  }
  if (platform === "linux") {
    return linuxKeychainAvailable();
  }
  return false;
}

export async function keychainGetKey(
  service: string,
  account: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer | null> {
  if (platform === "darwin") {
    return macKeychainGet(service, account);
  }
  if (platform === "linux") {
    return linuxKeychainGet(service, account);
  }
  return null;
}

export async function keychainSetKey(
  service: string,
  account: string,
  key: Buffer,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "darwin") {
    return macKeychainSet(service, account, key);
  }
  if (platform === "linux") {
    return linuxKeychainSet(service, account, key);
  }
  throw new Error(`Keychain not supported on platform: ${platform}`);
}

export async function keychainDeleteKey(
  service: string,
  account: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "darwin") {
    return macKeychainDelete(service, account);
  }
  if (platform === "linux") {
    return linuxKeychainDelete(service, account);
  }
}

/** Derive a stable keychain account identifier from a state directory. */
export function resolveKeychainAccount(stateDir: string): string {
  return accountForStateDir(stateDir);
}

/** Retrieve or generate a DEK via the OS keychain. */
export async function getOrCreateKeychainDek(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer> {
  const account = accountForStateDir(stateDir);
  const existing = await keychainGetKey(VAULT_KEYCHAIN_SERVICE, account, platform);
  if (existing && existing.length === 32) {
    return existing;
  }
  const { randomBytes } = await import("node:crypto");
  const dek = randomBytes(32);
  await keychainSetKey(VAULT_KEYCHAIN_SERVICE, account, dek, platform);
  return dek;
}
