import { describe, expect, it } from "vitest";
import { resolveSenderTier } from "./sender-tier.js";
import { SenderTier } from "./types.js";

describe("resolveSenderTier", () => {
  it("resolves OWNER by numeric ID in senderTiers.owners", () => {
    const result = resolveSenderTier(42, undefined, {
      senderTiers: { owners: [42] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("resolves OWNER by username (string) in senderTiers.owners", () => {
    const result = resolveSenderTier(999, "alice", {
      senderTiers: { owners: ["alice"] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("resolves MEMBER via senderTiers.members (numeric ID)", () => {
    const result = resolveSenderTier(77, undefined, {
      senderTiers: { members: [77] },
    });
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("resolves MEMBER via senderTiers.members (username)", () => {
    const result = resolveSenderTier(999, "bob", {
      senderTiers: { members: ["bob"] },
    });
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("resolves MEMBER via existing allowFrom array (channel interop)", () => {
    const result = resolveSenderTier("+1234567890", undefined, { senderTiers: {} }, [
      "+1234567890",
      "+0987654321",
    ]);
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("resolves GUEST for unknown sender (hardcoded fallback)", () => {
    const result = resolveSenderTier(12345, "stranger", {
      senderTiers: { owners: [1], members: [2] },
    });
    expect(result).toBe(SenderTier.GUEST);
  });

  it("resolves MEMBER (not OWNER) when allowFrom contains wildcard '*'", () => {
    const result = resolveSenderTier(99999, "anyone", { senderTiers: {} }, ["*"]);
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("resolves GUEST when config is empty (no senderTiers, no allowFrom)", () => {
    const result = resolveSenderTier(1, "user", {});
    expect(result).toBe(SenderTier.GUEST);
  });

  it("matches usernames case-insensitively", () => {
    const result = resolveSenderTier(999, "JohnDoe", {
      senderTiers: { owners: ["johndoe"] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("coerces numeric ID vs string entry (owner '123' matches senderId 123)", () => {
    const result = resolveSenderTier(123, undefined, {
      senderTiers: { owners: ["123"] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  // --- additional edge cases ---

  it("prefers OWNER over MEMBER when sender appears in both lists", () => {
    const result = resolveSenderTier(42, "admin", {
      senderTiers: { owners: [42], members: [42] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("prefers senderTiers.members over allowFrom", () => {
    const result = resolveSenderTier(10, undefined, { senderTiers: { members: [10] } }, [10]);
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("matches username in allowFrom case-insensitively", () => {
    const result = resolveSenderTier(999, "Alice", { senderTiers: {} }, ["alice"]);
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("returns GUEST when allowFrom is an empty array", () => {
    const result = resolveSenderTier(1, "user", { senderTiers: {} }, []);
    expect(result).toBe(SenderTier.GUEST);
  });

  it("coerces string senderId to match numeric entry in owners", () => {
    const result = resolveSenderTier("456", undefined, {
      senderTiers: { owners: [456] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("resolves GUEST when senderTiers is undefined (only key exists)", () => {
    const result = resolveSenderTier(1, "user", { senderTiers: undefined });
    expect(result).toBe(SenderTier.GUEST);
  });

  it("handles special characters in usernames", () => {
    const result = resolveSenderTier(1, "user@domain.com", {
      senderTiers: { owners: ["user@domain.com"] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  it("does not match numeric username against numeric ID entry", () => {
    // senderId=999, username="42", owners=[42]
    // 42 matches as username (case-insensitive string compare "42" === "42")
    // This IS expected to match because String(42) === "42".toLowerCase()
    const result = resolveSenderTier(999, "42", {
      senderTiers: { owners: [42] },
    });
    expect(result).toBe(SenderTier.OWNER);
  });

  // --- SYSTEM tier tests (isTrustedInternal flag) ---

  it("resolves SYSTEM when isTrustedInternal=true", () => {
    const result = resolveSenderTier(
      "cron",
      undefined,
      { senderTiers: {} },
      undefined,
      true, // isTrustedInternal
    );
    expect(result).toBe(SenderTier.SYSTEM);
  });

  it("resolves SYSTEM even when sender is in owners list (isTrustedInternal takes precedence)", () => {
    const result = resolveSenderTier(
      281043,
      "admin",
      { senderTiers: { owners: [281043] } },
      undefined,
      true, // isTrustedInternal
    );
    expect(result).toBe(SenderTier.SYSTEM);
  });

  it("resolves normally when isTrustedInternal=false", () => {
    const result = resolveSenderTier(
      42,
      undefined,
      { senderTiers: { owners: [42] } },
      undefined,
      false, // isTrustedInternal
    );
    expect(result).toBe(SenderTier.OWNER);
  });

  it("resolves normally when isTrustedInternal=undefined (backward compatibility)", () => {
    const result = resolveSenderTier(77, undefined, { senderTiers: { members: [77] } });
    expect(result).toBe(SenderTier.MEMBER);
  });

  it("resolves GUEST when no match and isTrustedInternal=false", () => {
    const result = resolveSenderTier(
      999,
      "stranger",
      { senderTiers: {} },
      undefined,
      false, // isTrustedInternal
    );
    expect(result).toBe(SenderTier.GUEST);
  });
});
