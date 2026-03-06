import { describe, expect, it } from "vitest";
import { UPCManager } from "./upc-manager.js";

describe("UPCManager", () => {
  it("clears all verification state without removing credential", () => {
    const manager = new UPCManager();
    manager.setUPC("secure-code");

    const firstAttempt = manager.verifyUPC("wrong", "session-a");
    expect(firstAttempt.verified).toBe(false);
    expect(firstAttempt.remainingAttempts).toBe(4);

    const verified = manager.verifyUPC("secure-code", "session-b");
    expect(verified.verified).toBe(true);
    expect(manager.isSessionVerified("session-b")).toBe(true);

    manager.clearAllVerifications();

    expect(manager.isEnabled()).toBe(true);
    expect(manager.isSessionVerified("session-b")).toBe(false);

    const secondAttempt = manager.verifyUPC("wrong", "session-a");
    expect(secondAttempt.verified).toBe(false);
    expect(secondAttempt.remainingAttempts).toBe(4);
  });
});
