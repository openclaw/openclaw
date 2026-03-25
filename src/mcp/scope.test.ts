import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { runMigrations } from "../infra/state-db/schema.js";
import {
  findServerScope,
  loadServersFromScope,
  mcpDirForScope,
  mcpLockFileForScope,
  removeServerFromScope,
  upsertServerInScope,
  writeServersToScope,
} from "./scope.js";
import {
  resetMcpServersDbForTest,
  setMcpServersDbForTest,
} from "./servers-sqlite.js";
import type { McpServerConfig } from "./types.js";

describe("mcpDirForScope", () => {
  const projectRoot = "/tmp/test-project";

  it("returns local scope directory", () => {
    expect(mcpDirForScope("local", projectRoot)).toBe("/tmp/test-project/.openclaw/mcp.local");
  });

  it("returns project scope directory", () => {
    expect(mcpDirForScope("project", projectRoot)).toBe("/tmp/test-project/.openclaw/mcp");
  });

  it("returns user scope directory", () => {
    const result = mcpDirForScope("user", projectRoot);
    expect(result).toContain(".openclaw/mcp");
    // Should NOT contain the project root for user scope
    expect(result).not.toContain(projectRoot);
  });
});

describe("mcpLockFileForScope", () => {
  const projectRoot = "/tmp/test-project";

  it("returns local lock file path", () => {
    expect(mcpLockFileForScope("local", projectRoot)).toBe(
      "/tmp/test-project/.openclaw/mcp.local-lock.yaml",
    );
  });

  it("returns project lock file path", () => {
    expect(mcpLockFileForScope("project", projectRoot)).toBe(
      "/tmp/test-project/.openclaw/mcp-lock.yaml",
    );
  });

  it("returns user lock file path", () => {
    const result = mcpLockFileForScope("user", projectRoot);
    expect(result).toContain(".openclaw/mcp-lock.yaml");
    expect(result).not.toContain(projectRoot);
  });
});

// ── Shared test server fixtures ──────────────────────────────────────────────

const testServer: McpServerConfig = {
  type: "http",
  url: "https://example.com/mcp",
};

const testStdioServer: McpServerConfig = {
  type: "stdio",
  command: "/usr/bin/node",
  args: ["server.js"],
  env: { API_KEY: "test123" },
};

// ── YAML scope tests (project / local) ──────────────────────────────────────

describe("scope read/write operations (project/local — YAML)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mcp-scope-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writeServersToScope + loadServersFromScope round-trips (project)", async () => {
    const servers = { "test-server": testServer, "stdio-server": testStdioServer };
    await writeServersToScope("project", tempDir, servers);

    const loaded = await loadServersFromScope("project", tempDir);
    expect(loaded["test-server"]).toMatchObject({ type: "http", url: "https://example.com/mcp" });
    expect(loaded["stdio-server"]).toMatchObject({ type: "stdio", command: "/usr/bin/node" });
  });

  it("upsertServerInScope adds a new server (project)", async () => {
    await upsertServerInScope("project", tempDir, "new-server", testServer);
    const loaded = await loadServersFromScope("project", tempDir);
    expect(loaded["new-server"]).toMatchObject({ type: "http" });
  });

  it("upsertServerInScope updates an existing server (project)", async () => {
    await upsertServerInScope("project", tempDir, "srv", testServer);
    await upsertServerInScope("project", tempDir, "srv", {
      ...testServer,
      url: "https://updated.com/mcp",
    });
    const loaded = await loadServersFromScope("project", tempDir);
    expect(loaded["srv"]?.url).toBe("https://updated.com/mcp");
  });

  it("removeServerFromScope removes a server (project)", async () => {
    await upsertServerInScope("project", tempDir, "srv", testServer);
    const removed = await removeServerFromScope("project", tempDir, "srv");
    expect(removed).toBe(true);
    const loaded = await loadServersFromScope("project", tempDir);
    expect(loaded["srv"]).toBeUndefined();
  });

  it("removeServerFromScope returns false for missing server (project)", async () => {
    const removed = await removeServerFromScope("project", tempDir, "nonexistent");
    expect(removed).toBe(false);
  });

  it("findServerScope finds server in correct scope (project vs local)", async () => {
    await upsertServerInScope("project", tempDir, "proj-only", testServer);
    await upsertServerInScope("local", tempDir, "local-only", testStdioServer);

    expect(await findServerScope("proj-only", tempDir)).toBe("project");
    expect(await findServerScope("local-only", tempDir)).toBe("local");
    expect(await findServerScope("nonexistent", tempDir)).toBeUndefined();
  });

  it("findServerScope returns narrowest scope when duplicate keys exist", async () => {
    await upsertServerInScope("project", tempDir, "dup", testServer);
    await upsertServerInScope("local", tempDir, "dup", testStdioServer);

    // local is narrower than project, should be found first
    expect(await findServerScope("dup", tempDir)).toBe("local");
  });

  it("writeServersToScope creates directory if missing (project)", async () => {
    const deepDir = join(tempDir, "deep", "nested");
    await writeServersToScope("project", deepDir, { srv: testServer });
    const loaded = await loadServersFromScope("project", deepDir);
    expect(loaded["srv"]).toMatchObject({ type: "http" });
  });

  it("loadServersFromScope returns empty for missing file (project)", async () => {
    const loaded = await loadServersFromScope("project", tempDir);
    expect(loaded).toEqual({});
  });
});

// ── SQLite scope tests (user) ────────────────────────────────────────────────

describe("scope read/write operations (user — SQLite)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mcp-scope-user-test-"));

    // Wire up an in-memory DB for the user-scope SQLite functions.
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setMcpServersDbForTest(db);
  });

  afterEach(async () => {
    resetMcpServersDbForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("upsertServerInScope adds a server in user scope (SQLite)", async () => {
    await upsertServerInScope("user", tempDir, "u-server", testServer);
    const loaded = await loadServersFromScope("user", tempDir);
    expect(loaded["u-server"]).toMatchObject({ type: "http", url: "https://example.com/mcp" });
  });

  it("upsertServerInScope updates an existing user-scope server", async () => {
    await upsertServerInScope("user", tempDir, "u-srv", testServer);
    await upsertServerInScope("user", tempDir, "u-srv", {
      ...testServer,
      url: "https://updated.com/mcp",
    });
    const loaded = await loadServersFromScope("user", tempDir);
    expect(loaded["u-srv"]?.url).toBe("https://updated.com/mcp");
  });

  it("removeServerFromScope removes a user-scope server", async () => {
    await upsertServerInScope("user", tempDir, "u-srv", testServer);
    const removed = await removeServerFromScope("user", tempDir, "u-srv");
    expect(removed).toBe(true);
    const loaded = await loadServersFromScope("user", tempDir);
    expect(loaded["u-srv"]).toBeUndefined();
  });

  it("removeServerFromScope returns false for missing user-scope server", async () => {
    const removed = await removeServerFromScope("user", tempDir, "nonexistent");
    expect(removed).toBe(false);
  });

  it("writeServersToScope bulk-upserts and deletes removed keys (user)", async () => {
    await upsertServerInScope("user", tempDir, "keep", testServer);
    await upsertServerInScope("user", tempDir, "remove", testStdioServer);

    await writeServersToScope("user", tempDir, { keep: testServer });
    const loaded = await loadServersFromScope("user", tempDir);
    expect(loaded["keep"]).toBeDefined();
    expect(loaded["remove"]).toBeUndefined();
  });

  it("loadServersFromScope returns empty when no user-scope servers exist", async () => {
    const loaded = await loadServersFromScope("user", tempDir);
    expect(loaded).toEqual({});
  });

  it("findServerScope finds server in user scope (SQLite)", async () => {
    await upsertServerInScope("user", tempDir, "user-only", testServer);
    expect(await findServerScope("user-only", tempDir)).toBe("user");
  });

  it("findServerScope returns local over user when both have a key", async () => {
    await upsertServerInScope("user", tempDir, "dup", testServer);
    await upsertServerInScope("local", tempDir, "dup", testStdioServer);
    expect(await findServerScope("dup", tempDir)).toBe("local");
  });
});
