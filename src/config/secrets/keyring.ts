/**
 * OS Keyring / macOS Keychain provider (stub).
 *
 * Covers platform-native credential stores:
 * - macOS Keychain (already on every Mac)
 * - Linux: libsecret / GNOME Keyring / KDE Wallet
 * - Windows: Credential Manager
 *
 * TODO: Implement using the `keytar` npm package for cross-platform support,
 * or native `security` CLI on macOS.
 *
 * Note: No implementation provided — we don't currently have access to test
 * across all platforms. Contributions welcome!
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";

/**
 * Creates an OS keyring / macOS Keychain secrets provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createKeyringSecretsProvider(): SecretsProvider {
  return {
    name: "keyring",
    async resolve(_secretName: string): Promise<string> {
      throw new Error(
        "OS keyring / macOS Keychain secrets provider is not yet implemented. " +
          "Contributions welcome — see src/config/secrets/keyring.ts",
      );
    },
  };
}
