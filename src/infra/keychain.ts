import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * KeychainBackend provides a cross-platform abstraction for storing sensitive strings/keys
 * in the operating system's secure credential store.
 */
export interface KeychainBackend {
  /**
   * Retrieve a key from the keychain. Returns null if not found or error.
   */
  get(service: string, account: string): Buffer | null;

  /**
   * Store a key in the keychain.
   */
  set(service: string, account: string, key: Buffer): void;

  /**
   * Delete a key from the keychain.
   */
  delete(service: string, account: string): void;

  /**
   * Check if the keychain backend is available and functional on this system.
   */
  isAvailable(): boolean;
}

/**
 * macOS implementation using the 'security' CLI tool.
 * Stores keys as hex-encoded passwords in generic password items.
 */
class DarwinKeychain implements KeychainBackend {
  get(service: string, account: string): Buffer | null {
    try {
      // -w only outputs the password (hex-encoded key)
      const output = execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return Buffer.from(output, "hex");
    } catch {
      return null;
    }
  }

  set(service: string, account: string, key: Buffer): void {
    const hex = key.toString("hex");
    try {
      // -U updates if exists, -w passes the password value.
      // The hex value appears in process args briefly but macOS `security` CLI
      // doesn't support stdin for -w. This is acceptable as Keychain access
      // itself requires user auth on macOS.
      execSync(`security add-generic-password -s "${service}" -a "${account}" -w "${hex}" -U`, {
        stdio: "ignore",
      });
    } catch {
      // If -U fails on older macOS, delete and re-add
      this.delete(service, account);
      execSync(`security add-generic-password -s "${service}" -a "${account}" -w "${hex}"`, {
        stdio: "ignore",
      });
    }
  }

  delete(service: string, account: string): void {
    try {
      execSync(`security delete-generic-password -s "${service}" -a "${account}"`, {
        stdio: "ignore",
      });
    } catch {
      // Ignore if it doesn't exist
    }
  }

  isAvailable(): boolean {
    try {
      execSync("security --help", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Linux implementation using 'secret-tool' (libsecret).
 * Requires gnome-keyring, kwallet, or other Secret Service implementation.
 */
class LinuxKeychain implements KeychainBackend {
  get(service: string, account: string): Buffer | null {
    try {
      const output = execSync(`secret-tool lookup service "${service}" account "${account}"`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return output ? Buffer.from(output, "hex") : null;
    } catch {
      return null;
    }
  }

  set(service: string, account: string, key: Buffer): void {
    const hex = key.toString("hex");
    // secret-tool store reads password from stdin — use input option to avoid
    // leaking the key via process arguments visible in `ps`
    execSync(
      `secret-tool store --label="OpenClaw Master Key" service "${service}" account "${account}"`,
      { stdio: ["pipe", "ignore", "ignore"], input: hex },
    );
  }

  delete(service: string, account: string): void {
    try {
      execSync(`secret-tool clear service "${service}" account "${account}"`, { stdio: "ignore" });
    } catch {
      // Ignore
    }
  }

  isAvailable(): boolean {
    try {
      execSync("secret-tool --help", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Windows implementation using PowerShell and DPAPI (Data Protection API).
 * Since Windows doesn't have a simple 'security' CLI for the Credential Manager that accepts arbitrary blobs easily,
 * we use DPAPI to encrypt the key at rest and store it in a file in %APPDATA%.
 * DPAPI keys are tied to the user's Windows login.
 */
class WindowsKeychain implements KeychainBackend {
  private getStoragePath(): string {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "openclaw", "master.key.dpapi");
  }

  get(_service: string, _account: string): Buffer | null {
    const filePath = this.getStoragePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const base64 = fs.readFileSync(filePath, "utf8").trim();
      const psCommand = `
        $bytes = [Convert]::FromBase64String("${base64}")
        $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Convert]::ToBase64String($unprotected)
      `;
      const output = execSync(`powershell -Command "${psCommand.replace(/\n/g, "")}"`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return Buffer.from(output, "base64");
    } catch {
      return null;
    }
  }

  set(_service: string, _account: string, key: Buffer): void {
    const filePath = this.getStoragePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const base64Key = key.toString("base64");
    const psCommand = `
      $bytes = [Convert]::FromBase64String("${base64Key}")
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($protected)
    `;
    const protectedBase64 = execSync(`powershell -Command "${psCommand.replace(/\n/g, "")}"`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    fs.writeFileSync(filePath, protectedBase64, { mode: 0o600 });
  }

  delete(_service: string, _account: string): void {
    const filePath = this.getStoragePath();
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore
      }
    }
  }

  isAvailable(): boolean {
    try {
      // Check if PowerShell and the required .NET assembly/method are available
      const checkCmd = `powershell -Command "[System.Security.Cryptography.ProtectedData]; exit 0"`;
      execSync(checkCmd, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

class FallbackKeychain implements KeychainBackend {
  get(): Buffer | null {
    return null;
  }
  set(): void {}
  delete(): void {}
  isAvailable(): boolean {
    return false;
  }
}

/**
 * Factory function to create the appropriate KeychainBackend for the current platform.
 */
export function createKeychainBackend(): KeychainBackend {
  switch (process.platform) {
    case "darwin":
      return new DarwinKeychain();
    case "linux":
      return new LinuxKeychain();
    case "win32":
      return new WindowsKeychain();
    default:
      return new FallbackKeychain();
  }
}
