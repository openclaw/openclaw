import { describe, expect, test } from "vitest";
import { createVaultBackend } from "./vault-backend.js";

describe("vault-backend", () => {
  describe("createVaultBackend", () => {
    test("returns KeychainBackend for 'keychain'", () => {
      const backend = createVaultBackend("keychain");
      expect(backend.name).toBe("keychain");
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
      expect(backend.set).toBeDefined();
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
      expect(backend.get).toBeDefined();
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
      expect(backend.delete).toBeDefined();
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
      expect(backend.list).toBeDefined();
    });

    test("throws 'not yet implemented' for '1password'", () => {
      expect(() => createVaultBackend("1password")).toThrow(
        "1Password backend not yet implemented",
      );
    });

    test("throws 'not yet implemented' for 'bitwarden'", () => {
      expect(() => createVaultBackend("bitwarden")).toThrow(
        "Bitwarden backend not yet implemented",
      );
    });

    test("throws 'not yet implemented' for 'vault'", () => {
      expect(() => createVaultBackend("vault")).toThrow(
        "HashiCorp Vault backend not yet implemented",
      );
    });

    test("throws 'Unknown vault backend' for invalid type", () => {
      expect(() => createVaultBackend("invalid-backend")).toThrow(
        "Unknown vault backend: invalid-backend",
      );
    });

    test("throws 'Unknown vault backend' for empty string", () => {
      expect(() => createVaultBackend("")).toThrow("Unknown vault backend: ");
    });
  });
});
