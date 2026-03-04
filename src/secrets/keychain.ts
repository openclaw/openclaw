/**
 * OS Keychain abstraction for OpenClaw secrets storage.
 *
 * Platform support:
 * - macOS: Uses `security` CLI with Keychain Services
 * - Linux: Uses `secret-tool` (libsecret) - basic implementation
 * - Windows: Uses Windows Credential Manager via cmdkey and PowerShell
 *
 * All operations are async and return null on missing/error.
 */

import { exec, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Execute a command and pipe data to stdin.
 * Required because promisified exec() doesn't support `input`.
 */
function execWithStdin(
  command: string,
  input: string,
  options?: { shell?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const shell = options?.shell ?? true;
    const child = spawn(command, [], { shell, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed (exit ${code}): ${stderr}`));
      }
    });
    child.on("error", reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

const SERVICE_NAME = "openclaw-secrets";

export type KeychainPlatform = "darwin" | "linux" | "win32" | "unsupported";

/**
 * Detect current platform for keychain operations.
 */
export function detectPlatform(): KeychainPlatform {
  const platform = os.platform();
  if (platform === "darwin") {
    return "darwin";
  }
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "win32") {
    return "win32";
  }
  return "unsupported";
}

/**
 * Retrieve a secret from the OS keychain.
 * @param name Secret identifier
 * @returns Secret value or null if not found
 */
export async function keychainGet(name: string): Promise<string | null> {
  const platform = detectPlatform();

  if (platform === "darwin") {
    return keychainGetMacOS(name);
  }

  if (platform === "linux") {
    return keychainGetLinux(name);
  }

  if (platform === "win32") {
    return keychainGetWindows(name);
  }

  throw new Error(`Keychain operations not supported on platform: ${os.platform()}`);
}

/**
 * Store a secret in the OS keychain.
 * @param name Secret identifier
 * @param value Secret value to store
 */
export async function keychainSet(name: string, value: string): Promise<void> {
  const platform = detectPlatform();

  if (platform === "darwin") {
    return keychainSetMacOS(name, value);
  }

  if (platform === "linux") {
    return keychainSetLinux(name, value);
  }

  if (platform === "win32") {
    return keychainSetWindows(name, value);
  }

  throw new Error(`Keychain operations not supported on platform: ${os.platform()}`);
}

/**
 * Delete a secret from the OS keychain.
 * @param name Secret identifier
 */
export async function keychainDelete(name: string): Promise<void> {
  const platform = detectPlatform();

  if (platform === "darwin") {
    return keychainDeleteMacOS(name);
  }

  if (platform === "linux") {
    return keychainDeleteLinux(name);
  }

  if (platform === "win32") {
    return keychainDeleteWindows(name);
  }

  throw new Error(`Keychain operations not supported on platform: ${os.platform()}`);
}

/**
 * List all secret names stored in the keychain.
 * @returns Array of secret names
 */
export async function keychainList(): Promise<string[]> {
  const platform = detectPlatform();

  if (platform === "darwin") {
    return keychainListMacOS();
  }

  if (platform === "linux") {
    return keychainListLinux();
  }

  if (platform === "win32") {
    return keychainListWindows();
  }

  throw new Error(`Keychain operations not supported on platform: ${os.platform()}`);
}

// ============================================================================
// macOS Implementation (security CLI)
// ============================================================================

async function keychainGetMacOS(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s "${SERVICE_NAME}" -a "${sanitize(name)}" -w`,
      { encoding: "utf8" },
    );
    return stdout.trim() || null;
  } catch {
    // security exits non-zero when item not found
    return null;
  }
}

async function keychainSetMacOS(name: string, value: string): Promise<void> {
  // Try to delete first (update requires different command)
  try {
    await keychainDeleteMacOS(name);
  } catch {
    // Ignore if doesn't exist
  }

  // Add new entry
  // macOS `security` requires password as -w argument (no stdin support).
  // Brief process arg exposure is acceptable — keychain is the secure store.
  const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await execAsync(
    `security add-generic-password -U -s "${SERVICE_NAME}" -a "${sanitize(name)}" -w "${escapedValue}"`,
    { encoding: "utf8" },
  );
}

async function keychainDeleteMacOS(name: string): Promise<void> {
  try {
    await execAsync(
      `security delete-generic-password -s "${SERVICE_NAME}" -a "${sanitize(name)}"`,
      { encoding: "utf8" },
    );
  } catch {
    // Ignore errors (item may not exist)
  }
}

async function keychainListMacOS(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `security dump-keychain | grep -A 1 "svce.*${SERVICE_NAME}" | grep "acct" | cut -d'"' -f 4`,
      { encoding: "utf8", shell: "/bin/bash" },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Linux Implementation (secret-tool / libsecret)
// ============================================================================

async function keychainGetLinux(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `secret-tool lookup service "${SERVICE_NAME}" account "${sanitize(name)}"`,
      { encoding: "utf8" },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainSetLinux(name: string, value: string): Promise<void> {
  await execWithStdin(
    `secret-tool store --label="${SERVICE_NAME}: ${sanitize(name)}" service "${SERVICE_NAME}" account "${sanitize(name)}"`,
    value,
  );
}

async function keychainDeleteLinux(name: string): Promise<void> {
  try {
    await execAsync(`secret-tool clear service "${SERVICE_NAME}" account "${sanitize(name)}"`, {
      encoding: "utf8",
    });
  } catch {
    // Ignore errors
  }
}

async function keychainListLinux(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `secret-tool search service "${SERVICE_NAME}" | grep "^attribute.account" | cut -d'=' -f2 | tr -d ' '`,
      { encoding: "utf8", shell: "/bin/bash" },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Windows Implementation (cmdkey + PowerShell CredRead)
// ============================================================================

async function keychainGetWindows(name: string): Promise<string | null> {
  try {
    const targetName = `${SERVICE_NAME}:${sanitize(name)}`;

    // Write a temp PowerShell script file — avoids all escaping issues
    const tmpDir = os.tmpdir();
    const scriptPath = path.join(tmpDir, `openclaw-cred-${Date.now()}.ps1`);
    const psScript = [
      `$code = @"`,
      `using System;`,
      `using System.Runtime.InteropServices;`,
      `public class CredManager {`,
      `  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]`,
      `  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);`,
      `  [DllImport("advapi32.dll")]`,
      `  public static extern void CredFree(IntPtr cred);`,
      `  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]`,
      `  public struct CREDENTIAL {`,
      `    public int Flags; public int Type; public string TargetName; public string Comment;`,
      `    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;`,
      `    public int Persist; public int AttributeCount; public IntPtr Attributes;`,
      `    public string TargetAlias; public string UserName;`,
      `  }`,
      `}`,
      `"@`,
      `Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue`,
      `$ptr = [IntPtr]::Zero`,
      `if ([CredManager]::CredRead('${targetName}', 1, 0, [ref]$ptr)) {`,
      `  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredManager+CREDENTIAL])`,
      `  $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2)`,
      `  [CredManager]::CredFree($ptr)`,
      `  Write-Output $secret`,
      `}`,
    ].join("\n");

    const fsSync = await import("node:fs/promises");
    await fsSync.writeFile(scriptPath, psScript, "utf8");

    try {
      const { stdout } = await execAsync(
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { encoding: "utf8" },
      );
      return stdout.trim() || null;
    } finally {
      // Clean up temp script
      await fsSync.unlink(scriptPath).catch(() => {});
    }
  } catch {
    return null;
  }
}

async function keychainSetWindows(name: string, value: string): Promise<void> {
  const targetName = `${SERVICE_NAME}:${sanitize(name)}`;

  // Delete existing credential first (cmdkey won't update)
  try {
    await keychainDeleteWindows(name);
  } catch {
    // Ignore if doesn't exist
  }

  // Use cmdkey directly — brief process arg exposure is acceptable
  const escapedValue = value.replace(/"/g, '""');
  await execAsync(`cmdkey /generic:"${targetName}" /user:openclaw /pass:"${escapedValue}"`, {
    encoding: "utf8",
  });
}

async function keychainDeleteWindows(name: string): Promise<void> {
  const targetName = `${SERVICE_NAME}:${sanitize(name)}`;
  try {
    await execAsync(`cmdkey /delete:"${targetName}"`, { encoding: "utf8", shell: "cmd.exe" });
  } catch {
    // Ignore errors (credential may not exist)
  }
}

async function keychainListWindows(): Promise<string[]> {
  try {
    const prefix = SERVICE_NAME;

    // Build PowerShell script to list credentials
    const script = [
      "cmdkey /list |",
      `Select-String 'Target:.*${prefix}:' |`,
      "ForEach-Object {",
      `  if($_.Line -match 'Target:.*${prefix}:(.+)$'){`,
      "    $matches[1].Trim()",
      "  }",
      "}",
    ].join(" ");

    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -NonInteractive -Command "${script}"`,
      { encoding: "utf8" },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Sanitize input for shell command safety.
 * Strips characters that could enable command injection.
 */
function sanitize(input: string): string {
  // Remove shell metacharacters, allow alphanumeric + common separators
  return input.replace(/[^a-zA-Z0-9_:.@]/g, "");
}
