import { describe, expect, it } from "vitest";
import { KeyringSecretProvider } from "./keyring-secret-provider.js";

describe("KeyringSecretProvider", () => {
  it("has name 'keyring'", () => {
    const provider = new KeyringSecretProvider();
    expect(provider.name).toBe("keyring");
  });

  it("setSecret throws (not implemented)", async () => {
    const provider = new KeyringSecretProvider();
    await expect(provider.setSecret("x", "y")).rejects.toThrow("not yet implemented");
  });

  it("listSecrets throws (not implemented)", async () => {
    const provider = new KeyringSecretProvider();
    await expect(provider.listSecrets()).rejects.toThrow("not yet implemented");
  });

  // Platform-specific tests are skipped in CI — they require real keyring access.
  // Run manually with: pnpm vitest run src/config/keyring-secret-provider.test.ts
});
