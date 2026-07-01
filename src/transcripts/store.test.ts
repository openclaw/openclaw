// Tests TranscriptsStore stream cleanup and transcript reading behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listOpenFileDescriptorsForPath } from "../../src/infra/open-file-descriptors.test-support.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { TranscriptsStore } from "./store.js";

const tempRoots: string[] = [];

describe("TranscriptsStore.readUtterancesFromSessionDir", () => {
  afterEach(() => {
    cleanupTempDirs(tempRoots);
  });

  it("returns an empty array when transcript.jsonl is missing", () => {
    const tmpDir = makeTempDir(tempRoots, "openclaw-transcript-test-");
    const store = new TranscriptsStore(tmpDir);
    const sessionDir = path.join(tmpDir, "2026-07-01", "missing");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 });

    return expect(result).resolves.toEqual([]);
  });

  it("reads utterances from transcript.jsonl", () => {
    const tmpDir = makeTempDir(tempRoots, "openclaw-transcript-test-");
    const store = new TranscriptsStore(tmpDir);
    const sessionDir = path.join(tmpDir, "2026-07-01", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "transcript.jsonl"),
      [
        JSON.stringify({ text: "hello", sessionId: "session-1" }),
        JSON.stringify({ text: "world", sessionId: "session-1" }),
      ].join("\n") + "\n",
    );

    const result = store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 });

    return expect(result).resolves.toEqual([
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({ text: "world" }),
    ]);
  });

  it("keeps only the tail when utterances exceed maxUtterances", () => {
    const tmpDir = makeTempDir(tempRoots, "openclaw-transcript-test-");
    const store = new TranscriptsStore(tmpDir);
    const sessionDir = path.join(tmpDir, "2026-07-01", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ text: `line-${i}`, sessionId: "session-1" }),
    );
    fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), lines.join("\n") + "\n");

    const result = store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 2 });

    return expect(result).resolves.toEqual([
      expect.objectContaining({ text: "line-3" }),
      expect.objectContaining({ text: "line-4" }),
    ]);
  });

  it.runIf(process.platform === "linux")(
    "does not leak file descriptors when JSON.parse throws",
    async () => {
      const tmpDir = makeTempDir(tempRoots, "openclaw-transcript-test-");
      const store = new TranscriptsStore(tmpDir);
      const sessionDir = path.join(tmpDir, "2026-07-01", "session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      const transcriptPath = path.join(sessionDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "not valid json\n");

      const fdsBefore = listOpenFileDescriptorsForPath(sessionDir);
      await expect(
        store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 }),
      ).rejects.toThrow();
      const fdsAfter = listOpenFileDescriptorsForPath(sessionDir);

      const leaked = fdsAfter.filter((p) => !fdsBefore.includes(p));
      expect(leaked).toHaveLength(0);
    },
  );

  it.runIf(process.platform === "linux")(
    "does not leak file descriptors in the happy path",
    async () => {
      const tmpDir = makeTempDir(tempRoots, "openclaw-transcript-test-");
      const store = new TranscriptsStore(tmpDir);
      const sessionDir = path.join(tmpDir, "2026-07-01", "session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      const transcriptPath = path.join(sessionDir, "transcript.jsonl");
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({ text: "hello", sessionId: "session-1" }) + "\n",
      );

      const fdsBefore = listOpenFileDescriptorsForPath(sessionDir);
      await store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 });
      const fdsAfter = listOpenFileDescriptorsForPath(sessionDir);

      const leaked = fdsAfter.filter((p) => !fdsBefore.includes(p));
      expect(leaked).toHaveLength(0);
    },
  );
});
