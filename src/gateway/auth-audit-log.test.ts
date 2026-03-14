import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthAuditLogger, type AuthAuditLogger } from "./auth-audit-log.js";

describe("auth audit logger", () => {
  let testDir: string;
  let logger: AuthAuditLogger;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  function makeTestDir(): string {
    testDir = path.join(
      tmpdir(),
      `auth-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    return testDir;
  }

  it("writes JSONL entries", async () => {
    const dir = makeTestDir();
    logger = createAuthAuditLogger({ logDir: dir });
    logger.log({ event: "auth_failure", clientIp: "10.0.0.1", reason: "token_mismatch" });
    logger.log({ event: "auth_success", clientIp: "10.0.0.2", method: "token" });
    await logger.flush();

    const content = await readFile(path.join(dir, "gateway-auth.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.event).toBe("auth_failure");
    expect(entry1.clientIp).toBe("10.0.0.1");
    expect(entry1.reason).toBe("token_mismatch");
    expect(entry1.ts).toBeDefined();

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.event).toBe("auth_success");
    expect(entry2.method).toBe("token");
  });

  it("rotates when file exceeds maxBytes", async () => {
    const dir = makeTestDir();
    logger = createAuthAuditLogger({ logDir: dir, maxBytes: 100, maxFiles: 2 });

    // Write enough to exceed 100 bytes.
    for (let i = 0; i < 5; i++) {
      logger.log({ event: "auth_failure", clientIp: `10.0.0.${i}`, reason: "test" });
    }
    await logger.flush();

    // Check that rotated file exists.
    const rotatedPath = path.join(dir, "gateway-auth.1.jsonl");
    const rotatedStat = await stat(rotatedPath).catch(() => null);
    expect(rotatedStat).not.toBeNull();
  });

  it("logs ip_blocked events", async () => {
    const dir = makeTestDir();
    logger = createAuthAuditLogger({ logDir: dir });
    logger.log({ event: "ip_blocked", clientIp: "203.0.113.1" });
    await logger.flush();

    const content = await readFile(path.join(dir, "gateway-auth.jsonl"), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.event).toBe("ip_blocked");
  });

  it("logs rate_limited events", async () => {
    const dir = makeTestDir();
    logger = createAuthAuditLogger({ logDir: dir });
    logger.log({ event: "rate_limited", clientIp: "10.0.0.99" });
    await logger.flush();

    const content = await readFile(path.join(dir, "gateway-auth.jsonl"), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.event).toBe("rate_limited");
  });
});
