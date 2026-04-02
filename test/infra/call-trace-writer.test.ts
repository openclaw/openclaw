import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { appendJsonl } from "../../src/infra/call-trace-writer";

describe("call-trace-writer", () => {
  const testDir = "/tmp/openclaw-test-traces";
  const testFile = path.join(testDir, "test.jsonl");

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
  });

  it("should remove 'seq' field from JSONL output", async () => {
    const recordWithSeq = {
      type: "test.event",
      seq: 123,
      ts: Date.now(),
      message: "test message",
      data: { key: "value" },
    };

    // Call the function
    appendJsonl(testFile, recordWithSeq);

    // Read the file content
    const content = await fs.readFile(testFile, "utf8");
    const parsed = JSON.parse(content.trim());

    // Verify seq field is not present
    expect(parsed).not.toHaveProperty("seq");

    // Verify other fields are present
    expect(parsed).toHaveProperty("type", "test.event");
    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("message", "test message");
    expect(parsed).toHaveProperty("data");
    expect(parsed.data).toEqual({ key: "value" });
  });

  it("should handle non-object records", async () => {
    const primitiveRecord = "plain string";
    appendJsonl(testFile, primitiveRecord);

    const content = await fs.readFile(testFile, "utf8");
    expect(content.trim()).toBe('"plain string"');
  });

  it("should handle null records", async () => {
    appendJsonl(testFile, null);

    const content = await fs.readFile(testFile, "utf8");
    expect(content.trim()).toBe("null");
  });
});
