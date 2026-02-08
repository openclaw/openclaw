import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { sanitizeTranscriptEntry } from "./transcript-sanitize.js";

describe("sanitizeTranscriptEntry", () => {
  test("passes through small entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-"));
    const transcriptPath = path.join(tmp, "s.jsonl");
    const entry = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    const out = sanitizeTranscriptEntry(transcriptPath, entry, { maxEntryBytes: 1024 }).entry as any;
    expect(out).toEqual(entry);
  });

  test("elides oversized message entries and writes artifact", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-"));
    const transcriptPath = path.join(tmp, "s.jsonl");

    const big = "x".repeat(50_000);
    const entry = {
      type: "message",
      id: "abc",
      timestamp: new Date().toISOString(),
      message: {
        role: "tool",
        content: [{ type: "text", text: big }],
      },
    };

    const res = sanitizeTranscriptEntry(transcriptPath, entry, { maxEntryBytes: 4096, previewChars: 128 });
    const out: any = res.entry;

    expect(out.type).toBe("message");
    expect(out.message).toBeTruthy();
    expect(out.message.elided).toBeTruthy();
    expect(typeof out.message.elided.artifactPath).toBe("string");

    const artifactPath = out.message.elided.artifactPath;
    expect(fs.existsSync(artifactPath)).toBe(true);

    const artifact = fs.readFileSync(artifactPath, "utf8");
    expect(artifact.length).toBeGreaterThan(10_000);

    // Ensure transcript content no longer contains the huge payload
    const outStr = JSON.stringify(out);
    expect(outStr.length).toBeLessThan(20_000);
  });
});
