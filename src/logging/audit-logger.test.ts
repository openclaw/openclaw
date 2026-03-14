import { describe, expect, test } from "vitest";
import { AuditLogger } from "./audit-logger.js";

function baseParams() {
  return {
    subject: "user:alice",
    object: "account:bob",
    action: "account.created" as const,
    outcome: "success" as const,
  };
}

describe("AuditLogger.log", () => {
  test("records an entry with auto-incrementing seq", () => {
    const logger = new AuditLogger();
    const e1 = logger.log(baseParams());
    const e2 = logger.log({ ...baseParams(), action: "account.disabled" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(logger.size).toBe(2);
  });

  test("first entry prevHash is genesis hash", () => {
    const logger = new AuditLogger();
    const entry = logger.log(baseParams());
    expect(entry.prevHash).toBe("0".repeat(64));
  });

  test("subsequent entry prevHash matches previous entry hash", () => {
    const logger = new AuditLogger();
    const e1 = logger.log(baseParams());
    const e2 = logger.log({ ...baseParams(), action: "account.enabled" });
    expect(e2.prevHash).toBe(e1.hash);
  });

  test("throws when detail contains a sensitive field name", () => {
    const logger = new AuditLogger();
    expect(() =>
      logger.log({
        ...baseParams(),
        detail: { password: "should-not-be-here" },
      }),
    ).toThrow(/sensitive field/i);
  });

  test("allows detail without sensitive fields", () => {
    const logger = new AuditLogger();
    const entry = logger.log({
      ...baseParams(),
      detail: { reason: "onboarding", role: "observer" },
    });
    expect(entry.detail).toEqual({ reason: "onboarding", role: "observer" });
  });
});

describe("AuditLogger.query", () => {
  function populatedLogger(): AuditLogger {
    const logger = new AuditLogger();
    logger.log({ subject: "alice", object: "acc1", action: "auth.login", outcome: "success" });
    logger.log({ subject: "bob", object: "acc2", action: "auth.login_failed", outcome: "failure" });
    logger.log({ subject: "alice", object: "cfg1", action: "config.changed", outcome: "success" });
    logger.log({ subject: "carol", object: "acc3", action: "access.denied", outcome: "denied" });
    return logger;
  }

  test("returns all entries when no filter given", () => {
    const logger = populatedLogger();
    expect(logger.query().length).toBe(4);
  });

  test("filters by subject", () => {
    const logger = populatedLogger();
    const aliceEntries = logger.query({ subject: "alice" });
    expect(aliceEntries.length).toBe(2);
    expect(aliceEntries.every((e) => e.subject === "alice")).toBe(true);
  });

  test("filters by action", () => {
    const logger = populatedLogger();
    const loginEntries = logger.query({ action: "auth.login" });
    expect(loginEntries.length).toBe(1);
  });

  test("filters by outcome", () => {
    const logger = populatedLogger();
    const denied = logger.query({ outcome: "denied" });
    expect(denied.length).toBe(1);
  });

  test("respects limit", () => {
    const logger = populatedLogger();
    const last2 = logger.query({ limit: 2 });
    expect(last2.length).toBe(2);
    expect(last2[1].seq).toBe(4);
  });
});

describe("AuditLogger.verifyIntegrity", () => {
  test("passes for an unmodified log", () => {
    const logger = new AuditLogger();
    logger.log(baseParams());
    logger.log({ ...baseParams(), action: "account.disabled" });
    logger.log({ ...baseParams(), action: "account.enabled" });
    expect(logger.verifyIntegrity()).toEqual({ valid: true });
  });

  test("passes for an empty log", () => {
    const logger = new AuditLogger();
    expect(logger.verifyIntegrity()).toEqual({ valid: true });
  });

  test("detects a tampered entry hash", () => {
    const logger = new AuditLogger();
    logger.log(baseParams());
    logger.log({ ...baseParams(), action: "account.disabled" });

    // Tamper with the first entry's hash.
    const entries = (logger as unknown as { entries: { hash: string }[] }).entries;
    const first = entries[0];
    if (first) {
      first.hash = "deadbeef" + "0".repeat(56);
    }

    const result = logger.verifyIntegrity();
    expect(result.valid).toBe(false);
  });
});
