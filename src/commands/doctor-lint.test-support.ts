// SQLite fixtures for Doctor lint read-only state checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";

export async function seedDoctorLintMcpToken(
  identity: McpOAuthIdentity,
  overrides: { expires_in?: number; refresh_token?: string } = {},
): Promise<void> {
  const { withMcpOAuthProviderForTest } = await import("../agents/mcp-oauth.test-support.js");
  await withMcpOAuthProviderForTest({ identity }, async (provider) => {
    await provider.saveTokens({
      access_token: "stored-inspection-token-not-real",
      token_type: "Bearer",
      expires_in: 3600,
      ...overrides,
    });
  });
}

export function createDoctorLintSemanticIndex(stateDir: string): string {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  );
  database
    .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
    .run("memory_index_meta_v1", JSON.stringify({ model: "embeddinggemma-300m", vectorDims: 768 }));
  database.close();
  return databasePath;
}

export function snapshotDoctorLintSqliteFamily(databasePath: string): Array<{
  path: string;
  sha256: string;
}> {
  // Closing raw descriptors in the writer's process releases its SQLite POSIX locks.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `const { createHash } = require("node:crypto");
         const fs = require("node:fs");
         const databasePath = process.argv[1];
         const family = ["", "-journal", "-shm", "-wal"]
           .map((suffix) => databasePath + suffix)
           .filter((candidate) => fs.existsSync(candidate))
           .map((candidate) => ({
             path: candidate,
             sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
           }));
         process.stdout.write(JSON.stringify(family));`,
        databasePath,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
  );
}
