// SQLite fixtures for Doctor lint read-only state checks.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";

export async function seedDoctorLintMcpToken(identity: McpOAuthIdentity): Promise<void> {
  const { createMcpOAuthClientProvider } = await import("../agents/mcp-oauth-provider.js");
  const provider = await createMcpOAuthClientProvider({ identity });
  await provider.saveTokens({
    access_token: "stored-inspection-token-not-real",
    token_type: "Bearer",
    expires_in: 3600,
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
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    }));
}
