/**
 * Integration tests for file-log sink-level redaction behavior.
 *
 * These tests verify that sensitive values written to the file log are masked
 * via redactSensitiveText applied at the sink exit, matching the same pattern
 * used by the diagnostics-otel transport (PR #18182).
 *
 * Design note: redaction runs on the already-serialized JSON string, not the
 * structured object. The DEFAULT_REDACT_PATTERNS are written for this — the
 * JSON credential pattern matches `"token":"<value>"` form. This is consistent
 * with how the OTEL transport applies redactSensitiveText to its log body.
 *
 * Scope: file-log transport only. registerLogTransport / external transports
 * are NOT tested here (deferred to a follow-up PR).
 */

import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

// ── Test setup ──────────────────────────────────────────────────────────────

const logPathTracker = createSuiteLogPathTracker("openclaw-test-redaction-behavior-");

describe("file-log redaction behavior", () => {
  let logPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    logPath = logPathTracker.nextPath();
    delete process.env.OPENCLAW_TEST_FILE_LOG;
    resetLogger();
    setLoggerOverride(null);
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

  it("masks JSON credential field in serialized log output", () => {
    const SECRET = "abcdef1234567890ghij";
    const MASKED = "abcdef\u2026ghij";

    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    // The token field is serialized as `"token":"<value>"` in JSON, which is
    // matched by the JSON credential pattern in DEFAULT_REDACT_PATTERNS.
    logger.info({ token: SECRET });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain(SECRET);
    expect(content).toContain(MASKED);
  });
});
