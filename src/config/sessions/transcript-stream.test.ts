import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionTranscriptTailLines,
  streamSessionTranscriptLines,
} from "./transcript-stream.js";

// Regression coverage for #54296: the transcript readers must stay correct and
// memory-bounded as session files grow into the multi-MB / 100s of MB range.
// The previous implementations called `fs.readFile` and split on newlines,
// which made memory usage scale with file size. These tests exercise the
// shared streaming helpers that replace those whole-file reads.

let tempDir = "";
let transcriptPath = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-stream-"));
  transcriptPath = path.join(tempDir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function collect(iter: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iter) {
    out.push(value);
  }
  return out;
}

describe("streamSessionTranscriptLines", () => {
  it("yields trimmed non-empty lines in file order", async () => {
    fs.writeFileSync(transcriptPath, "  alpha  \n\nbeta\n  \r\ngamma\n", "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns an empty iterator when the file does not exist", async () => {
    const lines = await collect(streamSessionTranscriptLines(path.join(tempDir, "missing.jsonl")));

    expect(lines).toEqual([]);
  });

  it("returns an empty iterator for an empty file", async () => {
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([]);
  });

  it("forwards malformed JSON lines as raw text so callers can choose to skip them", async () => {
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ id: "a" })}\nnot-json\n${JSON.stringify({ id: "b" })}\n`,
      "utf-8",
    );

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([JSON.stringify({ id: "a" }), "not-json", JSON.stringify({ id: "b" })]);
  });

  it("honours an abort signal between lines", async () => {
    fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");
    const controller = new AbortController();

    const out: string[] = [];
    for await (const line of streamSessionTranscriptLines(transcriptPath, {
      signal: controller.signal,
    })) {
      out.push(line);
      if (line === "one") {
        controller.abort();
      }
    }

    expect(out).toEqual(["one"]);
  });

  it("preserves long lines without truncation", async () => {
    const longLine = "x".repeat(64 * 1024 + 7);
    fs.writeFileSync(transcriptPath, `${longLine}\nshort\n`, "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([longLine, "short"]);
  });
});

describe("readSessionTranscriptTailLines", () => {
  it("returns trimmed non-empty lines in reverse order for short files", async () => {
    fs.writeFileSync(transcriptPath, "first\nsecond\nthird\n", "utf-8");

    const lines = await readSessionTranscriptTailLines(transcriptPath);

    expect(lines).toEqual(["third", "second", "first"]);
  });

  it("returns undefined when the file cannot be opened", async () => {
    const lines = await readSessionTranscriptTailLines(path.join(tempDir, "missing.jsonl"));

    expect(lines).toBeUndefined();
  });

  it("returns an empty array for an empty file", async () => {
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const lines = await readSessionTranscriptTailLines(transcriptPath);

    expect(lines).toEqual([]);
  });

  it("drops the leading partial line when the window does not start at byte zero", async () => {
    // Build a file longer than the requested tail window. The first line of
    // the slice we end up reading should be a suffix of an earlier line; the
    // helper must discard it so callers do not see corrupt JSON.
    const longPrefix = "x".repeat(2048);
    const content = `${longPrefix}\nbeta\ngamma\n`;
    fs.writeFileSync(transcriptPath, content, "utf-8");

    const lines = await readSessionTranscriptTailLines(transcriptPath, {
      maxBytes: 16,
    });

    expect(lines).not.toContain(longPrefix);
    expect(lines).toEqual(["gamma", "beta"]);
  });

  it("does not drop the first line when the window covers the entire file", async () => {
    fs.writeFileSync(transcriptPath, "alpha\nbeta\ngamma\n", "utf-8");

    const lines = await readSessionTranscriptTailLines(transcriptPath, {
      maxBytes: 64 * 1024,
    });

    expect(lines).toEqual(["gamma", "beta", "alpha"]);
  });

  it("clamps a sub-minimum maxBytes to the floor instead of returning nothing", async () => {
    fs.writeFileSync(transcriptPath, "alpha\nbeta\ngamma\n", "utf-8");

    const lines = await readSessionTranscriptTailLines(transcriptPath, {
      maxBytes: 16,
    });

    // The full file is smaller than the 1 KiB floor, so we still read the
    // whole file and return all three lines in reverse order.
    expect(lines).toEqual(["gamma", "beta", "alpha"]);
  });

  it("preserves JSONL line ordering so reverse scans hit the newest match first", async () => {
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ id: "first", role: "user" }),
        JSON.stringify({ id: "second", role: "assistant", text: "hi" }),
        JSON.stringify({ id: "third", role: "assistant", text: "bye" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const lines = await readSessionTranscriptTailLines(transcriptPath);

    expect(lines).toBeDefined();
    const parsed = lines!.map((line) => JSON.parse(line) as { id: string });
    expect(parsed.map((entry) => entry.id)).toEqual(["third", "second", "first"]);
  });
});
