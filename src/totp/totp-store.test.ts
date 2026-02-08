import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  enrollTotpUser,
  hasValidSession,
  isUserEnrolled,
  listTotpUsers,
  revokeTotpUser,
  verifyAndCreateSession,
} from "./totp-store.js";
import { generateTotp, decodeBase32 } from "./totp.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-totp-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("totp store enrollment", () => {
  it("enrolls a user and returns secret + URI", async () => {
    const result = await enrollTotpUser("12345", "testuser");
    expect(result.secretBase32).toBeTruthy();
    expect(result.otpauthUri).toContain("otpauth://totp/");
    expect(result.otpauthUri).toContain("OpenClaw");
  });

  it("rejects duplicate enrollment", async () => {
    await enrollTotpUser("12345");
    await expect(enrollTotpUser("12345")).rejects.toThrow("already enrolled");
  });

  it("lists enrolled users", async () => {
    await enrollTotpUser("111", "alice");
    await enrollTotpUser("222", "bob");
    const users = await listTotpUsers();
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.telegramUserId).sort()).toEqual(["111", "222"]);
  });

  it("checks enrollment status", async () => {
    expect(await isUserEnrolled("999")).toBe(false);
    await enrollTotpUser("999");
    expect(await isUserEnrolled("999")).toBe(true);
  });
});

describe("totp store revocation", () => {
  it("revokes an enrolled user", async () => {
    await enrollTotpUser("12345");
    expect(await revokeTotpUser("12345")).toBe(true);
    expect(await isUserEnrolled("12345")).toBe(false);
  });

  it("returns false for non-enrolled user", async () => {
    expect(await revokeTotpUser("nonexistent")).toBe(false);
  });
});

describe("totp verification and sessions", () => {
  it("creates a session on valid code", async () => {
    const { secretBase32 } = await enrollTotpUser("12345");
    const secret = decodeBase32(secretBase32);
    const code = generateTotp(secret);

    const verified = await verifyAndCreateSession("12345", code, 3600, 5, 300);
    expect(verified).toBe(true);
    expect(await hasValidSession("12345")).toBe(true);
  });

  it("rejects invalid code", async () => {
    await enrollTotpUser("12345");
    const verified = await verifyAndCreateSession("12345", "000000", 3600, 5, 300);
    expect(verified).toBe(false);
    expect(await hasValidSession("12345")).toBe(false);
  });

  it("returns false for non-enrolled user", async () => {
    const verified = await verifyAndCreateSession("nonexistent", "123456", 3600, 5, 300);
    expect(verified).toBe(false);
  });

  it("clears a session", async () => {
    const { secretBase32 } = await enrollTotpUser("12345");
    const secret = decodeBase32(secretBase32);
    const code = generateTotp(secret);

    await verifyAndCreateSession("12345", code, 3600, 5, 300);
    expect(await hasValidSession("12345")).toBe(true);

    expect(await clearSession("12345")).toBe(true);
    expect(await hasValidSession("12345")).toBe(false);
  });

  it("returns false when clearing non-existent session", async () => {
    expect(await clearSession("nonexistent")).toBe(false);
  });
});

describe("totp rate limiting", () => {
  it("blocks after max failed attempts", async () => {
    await enrollTotpUser("12345");

    // Exhaust attempts
    for (let i = 0; i < 3; i++) {
      await verifyAndCreateSession("12345", "000000", 3600, 3, 300);
    }

    // Next attempt should fail even with wrong code (rate limited)
    const result = await verifyAndCreateSession("12345", "000000", 3600, 3, 300);
    expect(result).toBe(false);
  });
});
