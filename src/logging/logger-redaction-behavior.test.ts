import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const secret = "sk-testsecret1234567890abcd";
const logPathTracker = createSuiteLogPathTracker("openclaw-log-redaction-");

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(() => {
  resetLogger();
  setLoggerOverride(null);
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("file log redaction", () => {
  it("redacts credential fields before writing JSONL file logs", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info({ apiKey: secret, message: "provider configured" });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("provider configured");
    expect(content).toContain('"apiKey"');
    expect(content).not.toContain(secret);
  });

  it("redacts bearer tokens in file log message strings", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().warn({ message: `Authorization: Bearer ${secret}` });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("Authorization: Bearer");
    expect(content).not.toContain(secret);
  });
});
