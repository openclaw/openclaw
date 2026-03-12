import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MemoryDocumentRow = {
  body: string;
  agentId: string | null;
  meta: string;
};

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function memoryDocumentKey(workspaceRoot: string, logicalPath: string): string {
  return `${workspaceRoot}\0${logicalPath}`;
}

const memoryDocuments = vi.hoisted(() => new Map<string, MemoryDocumentRow>());

const sqlUnsafe = vi.fn(async (query: string, params?: unknown[]) => {
  const normalized = normalizeSql(query);
  if (normalized.startsWith("insert into") && normalized.includes(".memory_documents")) {
    const [workspaceRoot, logicalPath, agentId, _updatedAt, body, meta] = params as [
      string,
      string,
      string | null,
      number,
      string,
      string,
    ];
    memoryDocuments.set(memoryDocumentKey(workspaceRoot, logicalPath), {
      body,
      agentId,
      meta,
    });
    return [];
  }
  if (normalized.startsWith("delete from") && normalized.includes(".memory_documents")) {
    const [workspaceRoot, logicalPath] = params as [string, string];
    memoryDocuments.delete(memoryDocumentKey(workspaceRoot, logicalPath));
    return [];
  }
  if (
    normalized.startsWith("select logical_path from") &&
    normalized.includes(".memory_documents")
  ) {
    const [workspaceRoot] = params as [string];
    return [...memoryDocuments.keys()]
      .filter((key) => key.startsWith(`${workspaceRoot}\0`))
      .map((key) => ({ logical_path: key.slice(workspaceRoot.length + 1) }));
  }
  if (normalized.startsWith("select body from") && normalized.includes(".memory_documents")) {
    const [workspaceRoot, logicalPath] = params as [string, string];
    const row = memoryDocuments.get(memoryDocumentKey(workspaceRoot, logicalPath));
    return row ? [{ body: row.body }] : [];
  }
  throw new Error(`Unexpected SQL in test: ${query}`);
});

vi.mock("./postgres-client.js", () => ({
  getPostgresPersistenceWithMode: vi.fn(async () => ({
    schemaSql: '"openclaw_test"',
    config: {
      url: "postgresql://openclaw:test@localhost/openclaw",
      schema: "openclaw_test",
      maxConnections: 1,
      exportCompatibility: true,
    },
    sql: {
      unsafe: sqlUnsafe,
    },
  })),
  getPostgresPersistenceForConfig: vi.fn(async () => ({
    schemaSql: '"openclaw_test"',
    config: {
      url: "postgresql://openclaw:test@localhost/openclaw",
      schema: "openclaw_test",
      maxConnections: 1,
      exportCompatibility: true,
    },
    sql: {
      unsafe: sqlUnsafe,
    },
  })),
  isPostgresPersistenceEnabled: () => true,
}));

const {
  readMemoryDocumentFromPostgres,
  reconcileMemoryDocumentFromFilesystemToPostgres,
  reconcileWorkspaceMemoryDocumentsToPostgres,
} = await import("./service.js");

describe("memory document reconciliation", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    memoryDocuments.clear();
    sqlUnsafe.mockClear();
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-reconcile-"));
  });

  afterEach(async () => {
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it("upserts current workspace memory docs and deletes stale rows", async () => {
    await fs.mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "# Memory\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "memory", "2026-03-12.md"), "# Daily\n", "utf8");

    memoryDocuments.set(memoryDocumentKey(workspaceRoot, "MEMORY.md"), {
      body: "stale-memory",
      agentId: "main",
      meta: "{}",
    });
    memoryDocuments.set(memoryDocumentKey(workspaceRoot, "memory/old.md"), {
      body: "stale-old",
      agentId: "main",
      meta: "{}",
    });

    const summary = await reconcileWorkspaceMemoryDocumentsToPostgres({
      workspaceRoot,
      agentId: "main",
    });

    expect(summary).toEqual({ upserted: 2, deleted: 1 });
    await expect(
      readMemoryDocumentFromPostgres({
        workspaceRoot,
        logicalPath: "MEMORY.md",
      }),
    ).resolves.toBe("# Memory\n");
    await expect(
      readMemoryDocumentFromPostgres({
        workspaceRoot,
        logicalPath: "memory/2026-03-12.md",
      }),
    ).resolves.toBe("# Daily\n");
    await expect(
      readMemoryDocumentFromPostgres({
        workspaceRoot,
        logicalPath: "memory/old.md",
      }),
    ).resolves.toBeNull();
  });

  it("removes a stale row when reconciling a missing single memory document", async () => {
    memoryDocuments.set(memoryDocumentKey(workspaceRoot, "MEMORY.md"), {
      body: "stale-memory",
      agentId: "main",
      meta: "{}",
    });

    await expect(
      reconcileMemoryDocumentFromFilesystemToPostgres({
        workspaceRoot,
        logicalPath: "MEMORY.md",
        agentId: "main",
      }),
    ).resolves.toBe(true);
    await expect(
      readMemoryDocumentFromPostgres({
        workspaceRoot,
        logicalPath: "MEMORY.md",
      }),
    ).resolves.toBeNull();
  });
});
