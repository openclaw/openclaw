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
  type AuditLogEntry,
} from "./audit-log.js";

function makeEvent(action: string): SecurityEvent {
  return {
    eventType: "auth.attempt",
    timestamp: new Date().toISOString(),
    severity: "info",
    action,
  };
}

async function readEntries(logPath: string): Promise<AuditLogEntry[]> {
  const raw = await fs.readFile(logPath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditLogEntry);
}

describe("audit-log writer", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-log-test-"));
    logPath = path.join(tmpDir, "security", "audit.jsonl");
    resetAuditWriter();
    setAuditLogPath(logPath);
  });

  afterEach(async () => {
    resetAuditWriter();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates genesis entry with seq=1 and prevHash=GENESIS", async () => {
    appendAuditEntry(makeEvent("test-genesis"));
    await flushAuditWriter();

    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seq).toBe(1);
    expect(entries[0]!.prevHash).toBe("GENESIS");
    expect(entries[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chains entries: second entry prevHash equals first entry hash", async () => {
    appendAuditEntry(makeEvent("first"));
    appendAuditEntry(makeEvent("second"));
    await flushAuditWriter();

    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.seq).toBe(2);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
  });

  it("handles concurrent writes: 5 synchronous calls produce sequential chain", async () => {
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(makeEvent(`concurrent-${i}`));
    }
    await flushAuditWriter();

    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      expect(entries[i]!.seq).toBe(i + 1);
      if (i === 0) {
        expect(entries[i]!.prevHash).toBe("GENESIS");
      } else {
        expect(entries[i]!.prevHash).toBe(entries[i - 1]!.hash);
      }
    }
  });

  it("recovers state after writer reset: 4th entry chains from 3rd", async () => {
    // Write 3 entries
    appendAuditEntry(makeEvent("one"));
    appendAuditEntry(makeEvent("two"));
    appendAuditEntry(makeEvent("three"));
    await flushAuditWriter();

    const entriesBefore = await readEntries(logPath);
    expect(entriesBefore).toHaveLength(3);

    // Reset writer state (simulates process restart)
    resetAuditWriter();
    setAuditLogPath(logPath);

    // Write 4th entry
    appendAuditEntry(makeEvent("four"));
    await flushAuditWriter();

    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(4);
    expect(entries[3]!.seq).toBe(4);
    expect(entries[3]!.prevHash).toBe(entries[2]!.hash);
  });
});
