import { describe, expect, it } from "vitest";
import { keychainAvailable, resolveKeychainAccount } from "./keychain.js";

describe("keychain", () => {
  it("resolveKeychainAccount returns consistent hash for same stateDir", () => {
    const account1 = resolveKeychainAccount("/home/user/.openclaw");
    const account2 = resolveKeychainAccount("/home/user/.openclaw");
    expect(account1).toBe(account2);
    expect(account1).toHaveLength(16);
  });

  it("resolveKeychainAccount returns different hash for different stateDirs", () => {
    const account1 = resolveKeychainAccount("/home/user/.openclaw");
    const account2 = resolveKeychainAccount("/home/other/.openclaw");
    expect(account1).not.toBe(account2);
  });

  it("keychainAvailable returns false for unsupported platforms", async () => {
    const result = await keychainAvailable("win32" as NodeJS.Platform);
    expect(result).toBe(false);
  });

  it("keychainAvailable returns false for freebsd", async () => {
    const result = await keychainAvailable("freebsd" as NodeJS.Platform);
    expect(result).toBe(false);
  });
});
