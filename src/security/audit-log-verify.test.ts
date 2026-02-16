import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityEvent } from "./events.js";
import {
  appendAuditEntry,
  flushAuditWriter,
  resetAuditWriter,
  setAuditLogPath,
} from "./audit-log.js";
import { verifyAuditLogChain } from "./audit-log-verify.js";

function makeEvent(action: string): SecurityEvent {
  return {
    eventType: "auth.attempt",
    timestamp: new Date().toISOString(),
    severity: "info",
    action,
  };
}

describe("audit-log-verify", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-verify-test-"));
    logPath = path.join(tmpDir, "security", "audit.jsonl");
    resetAuditWriter();
    setAuditLogPath(logPath);
  });

  afterEach(async () => {
    resetAuditWriter();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifies a valid chain of 3 entries", async () => {
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(3);
  });

  it("detects tampered entry (modified detail field)", async () => {
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    // Tamper with middle entry's action field
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entry = JSON.parse(lines[1]!) as Record<string, unknown>;
    const event = entry.event as Record<string, unknown>;
    event.action = "tampered";
    lines[1] = JSON.stringify(entry);
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf-8");

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.failedAtSeq).toBe(2);
      expect(result.error).toContain("Hash mismatch");
    }
  });

  it("detects deleted entry (missing middle line)", async () => {
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    // Remove middle line
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const withoutMiddle = [lines[0], lines[2]];
    await fs.writeFile(logPath, `${withoutMiddle.join("\n")}\n`, "utf-8");

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Seq gap: after entry 1, next is entry 3
      expect(result.error).toContain("Expected seq 2 but got 3");
    }
  });

  it("detects inserted entry (duplicated middle line)", async () => {
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    // Duplicate middle line
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const withDuplicate = [lines[0], lines[1], lines[1], lines[2]];
    await fs.writeFile(logPath, `${withDuplicate.join("\n")}\n`, "utf-8");

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // After seq 2, another seq 2 appears — expected seq 3
      expect(result.error).toContain("Expected seq 3 but got 2");
    }
  });

  it("returns valid with entryCount=0 for empty file", async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, "", "utf-8");

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(0);
  });

  it("handles truncated last line gracefully", async () => {
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    // Append partial JSON
    await fs.appendFile(logPath, '{"seq":4,"timestamp":"broken\n', "utf-8");

    const result = await verifyAuditLogChain(logPath);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(3);
  });

  it("returns valid with entryCount=0 for non-existent file", async () => {
    const result = await verifyAuditLogChain(path.join(tmpDir, "nonexistent.jsonl"));
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(0);
  });
});
