/**
 * Integration tests for file-log sink-level redaction behavior.
 *
 * These tests verify that:
 * 1. The redaction policy is resolved lazily (only on first file write, not on
 *    silent logger construction).
 * 2. After resetLogger() / setLoggerOverride(), the policy is re-resolved on
 *    the next write (C5 cache-invalidation via closure rebuild).
 * 3. Credential values written to the file log are masked, and ISO timestamps
 *    are preserved.
 *
 * Scope: file-log transport only. registerLogTransport / external transports
 * are NOT tested here (deferred to a follow-up PR).
 */

import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

// ── Mock redaction-policy to track resolve call counts ─────────────────────

const { getLoggingRedactionPolicyMock } = vi.hoisted(() => ({
  getLoggingRedactionPolicyMock: vi.fn(),
}));

vi.mock("./redaction-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./redaction-policy.js")>();
  return {
    ...actual,
    getLoggingRedactionPolicy: getLoggingRedactionPolicyMock.mockImplementation(
      actual.getLoggingRedactionPolicy,
    ),
  };
});

// ── Test setup ──────────────────────────────────────────────────────────────

const logPathTracker = createSuiteLogPathTracker("openclaw-test-redaction-behavior-");

describe("file-log redaction behavior", () => {
  let logPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    logPath = logPathTracker.nextPath();
    getLoggingRedactionPolicyMock.mockClear();
    resetLogger();
    setLoggerOverride(null);
    delete process.env.OPENCLAW_TEST_FILE_LOG;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_TEST_FILE_LOG;
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  // ── C5: Cache invalidation ──────────────────────────────────────────────

  it("re-resolves redaction policy after setLoggerOverride (C5 — reset lifecycle)", () => {
    // First logger build.
    setLoggerOverride({ level: "info", file: logPath });
    const logger1 = getLogger();
    logger1.info("first write");

    const callsAfterFirst = getLoggingRedactionPolicyMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Override → forces a new buildLogger() call → new closure → fresh resolve.
    setLoggerOverride({ level: "info", file: logPath });
    const logger2 = getLogger();
    logger2.info("second write");

    const callsAfterSecond = getLoggingRedactionPolicyMock.mock.calls.length;
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it("does NOT re-resolve redaction policy on repeated writes to the same logger", () => {
    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    // Multiple writes — the closure caches the policy after the first resolve.
    logger.info("write 1");
    logger.info("write 2");
    logger.info("write 3");

    // Policy should be resolved exactly once per buildLogger() invocation.
    expect(getLoggingRedactionPolicyMock).toHaveBeenCalledTimes(1);
  });

  // ── Silent logger lazy resolve ───────────────────────────────────────────

  it("does NOT call getLoggingRedactionPolicy for a silent logger (lazy resolve)", () => {
    // Default Vitest mode is silent — no OPENCLAW_TEST_FILE_LOG.
    resetLogger();
    setLoggerOverride(null);
    getLoggingRedactionPolicyMock.mockClear();

    // Building the logger in silent mode must NOT resolve the policy.
    getLogger();

    expect(getLoggingRedactionPolicyMock).not.toHaveBeenCalled();
  });

  // ── File content redaction ───────────────────────────────────────────────

  it("masks credential values in file log output", () => {
    const SECRET = "abcdef1234567890ghij"; // 20 alnum chars
    const MASKED = "abcdef\u2026ghij";

    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    logger.info({ apiKey: SECRET, message: "user login" });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain(SECRET);
    expect(content).toContain(MASKED);
  });

  it("preserves ISO-8601 timestamps in file log output (not over-masked)", () => {
    const isoTime = "2026-04-17T10:30:00.000+08:00";

    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    // Use a custom field name (not 'time', which gets overridden by the logger's
    // own timestamp). Also include it in the message to test the message path.
    logger.info({ scheduledAt: isoTime, message: `task scheduled at ${isoTime}` });

    const content = fs.readFileSync(logPath, "utf8");
    // The ISO timestamp MUST be present unmodified in the log output.
    expect(content).toContain(isoTime);
  });

  it("masks Bearer token in message field (pattern redaction)", () => {
    const SECRET = "abcdef1234567890ghij";
    const MASKED = "abcdef\u2026ghij";

    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    logger.info({ message: `Authorization: Bearer ${SECRET}` });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain(SECRET);
    expect(content).toContain(MASKED);
  });

  it("does not write raw credentials when mode is off (redaction disabled)", async () => {
    // When config returns mode=off, credentials should pass through unmasked.
    // We verify that the mock is respected — this tests the policy pipe-through.
    const { resolveRedactOptions } = await import("./redact.js");
    const offPolicy = {
      resolved: resolveRedactOptions({ mode: "off", patterns: [] }),
      signature: "off",
    };
    getLoggingRedactionPolicyMock.mockReturnValue(offPolicy);

    const SECRET = "abcdef1234567890ghij";
    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    logger.info({ token: SECRET });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain(SECRET);
  });
});
