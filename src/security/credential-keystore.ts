/**
 * Platform keystore abstraction for credential encryption master key storage.
 *
 * When available, the device private key (used for credential encryption key derivation)
 * is wrapped and stored in the platform keystore (e.g. macOS Keychain) for additional
 * protection. Falls back to filesystem-only storage on unsupported platforms.
 */

export type KeystoreBackend = {
  /** Whether this backend is available on the current platform. */
  isAvailable(): boolean;
  /** Store a value in the platform keystore. Returns true on success. */
  store(service: string, account: string, value: string): boolean;
  /** Retrieve a value from the platform keystore. Returns null if not found. */
  retrieve(service: string, account: string): string | null;
  /** Delete a value from the platform keystore. Returns true on success. */
  delete(service: string, account: string): boolean;
};

export const KEYSTORE_SERVICE = "openclaw-credential-encryption";
export const KEYSTORE_ACCOUNT = "device-master-key";

/**
 * Resolve the best available keystore backend for the current platform.
 *
 * Priority:
 * 1. macOS Keychain (darwin)
 * 2. Null backend (filesystem-only fallback)
 */
export function resolveKeystoreBackend(platform?: NodeJS.Platform): KeystoreBackend {
  const p = platform ?? process.platform;
  if (p === "darwin") {
    // Lazy import to avoid loading macOS-specific code on other platforms.
    // Uses a dynamic import boundary for the macOS backend.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { macosKeystoreBackend } = require("./keystore-macos.js") as {
        macosKeystoreBackend: KeystoreBackend;
      };
      if (macosKeystoreBackend.isAvailable()) {
        return macosKeystoreBackend;
      }
    } catch {
      // Fall through to null backend
    }
  }
  return nullKeystoreBackend;
}

/** No-op backend for platforms without a native keystore. */
export const nullKeystoreBackend: KeystoreBackend = {
  isAvailable: () => false,
  store: () => false,
  retrieve: () => null,
  delete: () => false,
};
