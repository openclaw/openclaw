import { describe, it, expect } from "vitest";
import { createKeychainBackend } from "./keychain.js";

// Minimal test that only tests the keychain backend logic itself
// avoiding the complex mocking of crypto-store for now

describe("KeychainBackend", () => {
  it("should detect platform and return backend", () => {
    const backend = createKeychainBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.isAvailable).toBe("function");
  });

  if (process.platform === "linux") {
    it("should have Linux implementation", () => {
      const backend = createKeychainBackend();
      expect(backend.constructor.name).toBe("LinuxKeychain");
    });
  }
});
