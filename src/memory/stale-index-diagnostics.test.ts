import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { requireNodeSqlite } from "./sqlite.js";
import { detectStaleMemoryAgentIndexes } from "./stale-index-diagnostics.js";

async function writeMemoryFile(workspaceDir: string, relPath: string, content: string) {
  const absPath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf8");
}

function seedMemoryIndex(dbPath: string, indexedPaths: string[]) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE files (path TEXT NOT NULL, source TEXT NOT NULL)`);
    const insert = db.prepare(`INSERT INTO files (path, source) VALUES (?, ?)`);
    for (const entry of indexedPaths) {
      insert.run(entry, "memory");
    }
  } finally {
    db.close();
  }
}

describe("detectStaleMemoryAgentIndexes", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("finds agents whose memory db is missing workspace files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-stale-"));
    cleanupDirs.push(root);

    const mainWorkspace = path.join(root, "main-workspace");
    const codexWorkspace = path.join(root, "codex-workspace");
    const mainDbPath = path.join(root, "memory", "main.sqlite");
    const codexDbPath = path.join(root, "memory", "codex.sqlite");

    await writeMemoryFile(mainWorkspace, "MEMORY.md", "# main\n");
    await writeMemoryFile(mainWorkspace, "memory/2026-03-17.md", "# indexed\n");
    await writeMemoryFile(codexWorkspace, "MEMORY.md", "# codex\n");
    await writeMemoryFile(codexWorkspace, "memory/2026-03-17.md", "# indexed\n");
    await writeMemoryFile(codexWorkspace, "memory/2026-03-19.md", "# stale\n");
    await fs.mkdir(path.dirname(mainDbPath), { recursive: true });

    seedMemoryIndex(mainDbPath, ["MEMORY.md", "memory/2026-03-17.md"]);
    seedMemoryIndex(codexDbPath, ["MEMORY.md", "memory/2026-03-17.md"]);

    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            workspace: mainWorkspace,
            memorySearch: { store: { path: mainDbPath } },
          },
          {
            id: "codex",
            workspace: codexWorkspace,
            memorySearch: { store: { path: codexDbPath } },
          },
        ],
      },
    } as OpenClawConfig;

    const stale = await detectStaleMemoryAgentIndexes(cfg);

    expect(stale).toEqual([
      {
        agentId: "codex",
        dbPath: codexDbPath,
        staleCount: 1,
        missingPaths: ["memory/2026-03-19.md"],
      },
    ]);
  });
});
