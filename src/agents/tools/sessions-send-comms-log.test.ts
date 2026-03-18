import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendCommsLog, type CommsLogEntry } from "./sessions-send-comms-log.js";

describe("appendCommsLog", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let originalCommsLog: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comms-log-test-"));
    originalEnv = process.env.SIGNAL_DIR;
    originalCommsLog = process.env.OPENCLAW_COMMS_LOG;
    process.env.SIGNAL_DIR = tmpDir;
    delete process.env.OPENCLAW_COMMS_LOG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SIGNAL_DIR;
    } else {
      process.env.SIGNAL_DIR = originalEnv;
    }
    if (originalCommsLog === undefined) {
      delete process.env.OPENCLAW_COMMS_LOG;
    } else {
      process.env.OPENCLAW_COMMS_LOG = originalCommsLog;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const logPath = () => path.join(tmpDir, "bus.jsonl");

  // Poll until file exists and has content, avoiding flaky setTimeout
  const flush = () =>
    vi.waitFor(() => expect(fs.existsSync(logPath())).toBe(true), { timeout: 2000 });

  it("writes a JSONL entry to bus.jsonl", async () => {
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
    await flush();

    const lines = fs.readFileSync(logPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("MESSAGE");
    expect(parsed.from).toBe("agent:tech:main");
    expect(parsed.to).toBe("agent:content:main");
    expect(parsed.status).toBe("ok");
    expect(parsed.messagePreview).toBe("Hello from tech");
    expect(parsed.replyPreview).toBe("Hello back");
  });

  it("appends multiple entries", async () => {
    appendCommsLog({
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "ok",
    });
    appendCommsLog({
      type: "MESSAGE",
      from: "agent:content:main",
      to: "agent:tech:main",
      ts: "2026-03-18T19:01:00Z",
      status: "accepted",
    });
    await flush();

    // Wait a bit more for the second entry
    await vi.waitFor(
      () => {
        const lines = fs.readFileSync(logPath(), "utf-8").trim().split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2000 },
    );
  });

  it("truncates previews longer than 200 characters", async () => {
    const longMessage = "a".repeat(300);
    const longReply = "b".repeat(250);

    appendCommsLog({
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "ok",
      messagePreview: longMessage,
      replyPreview: longReply,
    });
    await flush();

    const parsed = JSON.parse(fs.readFileSync(logPath(), "utf-8").trim());
    // 200 chars + "…" = 201 total
    expect(parsed.messagePreview).toHaveLength(201);
    expect(parsed.messagePreview.endsWith("…")).toBe(true);
    expect(parsed.replyPreview).toHaveLength(201);
    expect(parsed.replyPreview.endsWith("…")).toBe(true);
  });

  it("preserves short previews without truncation", async () => {
    appendCommsLog({
      type: "MESSAGE",
      from: "a",
      to: "b",
      ts: "2026-01-01T00:00:00Z",
      status: "ok",
      messagePreview: "short message",
    });
    await flush();

    const parsed = JSON.parse(fs.readFileSync(logPath(), "utf-8").trim());
    expect(parsed.messagePreview).toBe("short message");
  });

  it("logs failure statuses", async () => {
    appendCommsLog({
      type: "MESSAGE",
      from: "agent:tech:main",
      to: "agent:content:main",
      ts: "2026-03-18T19:00:00Z",
      status: "timeout",
      messagePreview: "timed out request",
    });
    await flush();

    const parsed = JSON.parse(fs.readFileSync(logPath(), "utf-8").trim());
    expect(parsed.status).toBe("timeout");
  });

  it("does not throw on write failure", () => {
    process.env.SIGNAL_DIR = "/nonexistent/readonly/path";
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

  it("respects OPENCLAW_COMMS_LOG=off", () => {
    process.env.OPENCLAW_COMMS_LOG = "off";
    appendCommsLog({
      type: "MESSAGE",
      from: "a",
      to: "b",
      ts: "2026-01-01T00:00:00Z",
      status: "ok",
    });
    // isLoggingEnabled() returns false synchronously, so no I/O is ever started.
    expect(fs.existsSync(logPath())).toBe(false);
  });
});
