import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

const createdDirs: string[] = [];

async function createCaseDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  createdDirs.length = 0;
});

describe("enforceSessionDiskBudget", () => {
  it("does not treat referenced transcripts with marker-like session IDs as archived artifacts", async () => {
    const dir = await createCaseDir("openclaw-disk-budget-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "keep.deleted.keep";
    const activeKey = "agent:main:main";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const store: Record<string, SessionEntry> = {
      [activeKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(transcriptPath, "x".repeat(256), "utf-8");

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      activeSessionKey: activeKey,
      maintenance: {
        maxDiskBytes: 150,
        highWaterBytes: 100,
      },
      warnOnly: false,
    });

    await expect(fs.stat(transcriptPath)).resolves.toBeDefined();
    expect(result).toEqual(
      expect.objectContaining({
        removedFiles: 0,
      }),
    );
  });

  it("removes true archived transcript artifacts while preserving referenced primary transcripts", async () => {
    const dir = await createCaseDir("openclaw-disk-budget-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "keep";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const archivePath = path.join(
      dir,
      `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 24 * 60 * 60 * 1000)}`,
    );
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
    await fs.writeFile(archivePath, "a".repeat(260), "utf-8");

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      maintenance: {
        maxDiskBytes: 300,
        highWaterBytes: 220,
      },
      warnOnly: false,
    });

    await expect(fs.stat(transcriptPath)).resolves.toBeDefined();
    await expect(fs.stat(archivePath)).rejects.toThrow();
    expect(result).toEqual(
      expect.objectContaining({
        removedFiles: 1,
        removedEntries: 0,
      }),
    );
  });
});
