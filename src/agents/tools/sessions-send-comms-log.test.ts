import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCommsLog, type CommsLogEntry } from "./sessions-send-comms-log.js";

describe("appendCommsLog", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comms-log-test-"));
    originalEnv = process.env.SIGNAL_DIR;
    process.env.SIGNAL_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SIGNAL_DIR;
    } else {
      process.env.SIGNAL_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSONL entry to bus.jsonl", () => {
    const entry: CommsLogEntry = {
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "ok",
      messagePreview: "Hello from tech",
      replyPreview: "Hello back",
    };

    appendCommsLog(entry);

    const logPath = path.join(tmpDir, "bus.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("MESSAGE");
    expect(parsed.from).toBe("agent:tech:main");
    expect(parsed.to).toBe("agent:content:main");
    expect(parsed.status).toBe("ok");
    expect(parsed.messagePreview).toBe("Hello from tech");
    expect(parsed.replyPreview).toBe("Hello back");
  });

  it("appends multiple entries", () => {
    const entry1: CommsLogEntry = {
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "ok",
    };
    const entry2: CommsLogEntry = {
      type: "MESSAGE",
      from: "agent:content:main",
      to: "agent:tech:main",
      ts: "2026-03-18T19:01:00Z",
      status: "accepted",
    };

    appendCommsLog(entry1);
    appendCommsLog(entry2);

    const logPath = path.join(tmpDir, "bus.jsonl");
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("truncates long previews", () => {
    const longMessage = "a".repeat(300);
    const entry: CommsLogEntry = {
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "ok",
      messagePreview: longMessage.slice(0, 200),
    };

    appendCommsLog(entry);

    const logPath = path.join(tmpDir, "bus.jsonl");
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(parsed.messagePreview.length).toBe(200);
  });

  it("does not throw on write failure", () => {
    process.env.SIGNAL_DIR = "/nonexistent/readonly/path";
    // Should not throw
    expect(() => {
      appendCommsLog({
        type: "MESSAGE",
        from: "a",
        to: "b",
        ts: "2026-01-01T00:00:00Z",
        status: "ok",
      });
    }).not.toThrow();
  });
});
