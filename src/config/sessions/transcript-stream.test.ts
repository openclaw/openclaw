import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  streamSessionTranscriptLines,
  streamSessionTranscriptLinesReverse,
} from "./transcript-stream.js";

// #54296: stream large transcripts rather than reading and splitting the entire file.
let tempDir = "";
let transcriptPath = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-stream-"));
  transcriptPath = path.join(tempDir, "session.jsonl");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function collect(iter: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iter) {
    out.push(value);
  }
  return out;
}
const forward = (file = transcriptPath) => collect(streamSessionTranscriptLines(file));
const reverse = (file = transcriptPath) => collect(streamSessionTranscriptLinesReverse(file));

it("returns empty iterators for empty files in both directions", async () => {
  fs.writeFileSync(transcriptPath, "", "utf-8");
  await expect(forward()).resolves.toEqual([]);
  await expect(reverse()).resolves.toEqual([]);
});

it.each([forward, reverse])("returns no lines for a missing file (%#)", async (read) => {
  await expect(read(path.join(tempDir, "missing.jsonl"))).resolves.toEqual([]);
});

it("yields trimmed non-empty lines in file order", async () => {
  const longLine = "alpha".repeat(14 * 1024);
  fs.writeFileSync(transcriptPath, `  ${longLine}  \n\nbeta\n  \r\ngamma\n`, "utf-8");

  await expect(forward()).resolves.toEqual([longLine, "beta", "gamma"]);
});

it("propagates stat failures other than ENOENT", async () => {
  const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(error);

  await expect(forward("/some/protected/transcript.jsonl")).rejects.toBe(error);
});

it("closes the stream when a consumer stops between lines", async () => {
  fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");
  const createReadStream = vi.spyOn(fs, "createReadStream");
  const out: string[] = [];
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    out.push(line);
    break;
  }

  expect(out).toEqual(["one"]);
  expect(createReadStream.mock.results[0]?.value.destroyed).toBe(true);
});
it("propagates open failures other than ENOENT", async () => {
  const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  vi.spyOn(fs.promises, "open").mockRejectedValueOnce(error);

  await expect(reverse("/some/protected/transcript.jsonl")).rejects.toBe(error);
});

it("preserves multibyte UTF-8 across chunk boundaries", async () => {
  const firstLine = `${"a".repeat(1100)}🌊`;
  // The first reverse read splits the wave's four UTF-8 bytes at the 64 KiB boundary.
  const secondLine = `${"b".repeat(65529)}✅`;
  fs.writeFileSync(transcriptPath, `${firstLine}\n${secondLine}\n`, "utf-8");

  await expect(reverse()).resolves.toEqual([secondLine, firstLine]);
});

it("closes the file when a consumer stops between reverse lines", async () => {
  fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");
  const open = vi.spyOn(fs.promises, "open");
  const out: string[] = [];
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    out.push(line);
    break;
  }

  expect(out).toEqual(["three"]);
  expect((await open.mock.results[0]?.value)?.fd).toBe(-1);
});
