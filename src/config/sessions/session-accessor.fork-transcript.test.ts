// Behavior tests for the accessor fork-transcript creation boundary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createForkedSessionTranscript } from "./session-accessor.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

const tempDirs: string[] = [];

function makeSessionsDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fork-transcript-")));
  tempDirs.push(dir);
  return dir;
}

function readJsonlRecords(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("writes a header-only fork artifact with parent lineage", async () => {
  const sessionsDir = makeSessionsDir();
  const fork = await createForkedSessionTranscript({
    cwd: "/workspace/project",
    parentSessionFile: "/sessions/parent.jsonl",
    sessionsDir,
  });

  expect(path.dirname(fork.sessionFile)).toBe(sessionsDir);
  expect(fork.sessionFile.endsWith(`_${fork.sessionId}.jsonl`)).toBe(true);
  const records = readJsonlRecords(fork.sessionFile);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: fork.sessionId,
    cwd: "/workspace/project",
    parentSession: "/sessions/parent.jsonl",
  });
});

it("copies built records in order sharing the fork header timestamp", async () => {
  const sessionsDir = makeSessionsDir();
  const fork = await createForkedSessionTranscript({
    cwd: "/workspace/project",
    parentSessionFile: "/sessions/parent.jsonl",
    sessionsDir,
    buildEntries: ({ sessionId, timestamp }) => [
      { type: "message", id: "m-1", parentId: null },
      { type: "leaf", id: "leaf-1", parentId: "m-1", timestamp, forkSessionId: sessionId },
    ],
  });

  const records = readJsonlRecords(fork.sessionFile);
  expect(records.map((record) => record.type)).toEqual(["session", "message", "leaf"]);
  expect(records[2]?.timestamp).toBe(records[0]?.timestamp);
  expect(records[2]?.forkSessionId).toBe(fork.sessionId);
});
