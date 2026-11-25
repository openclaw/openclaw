import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSqliteSessionSchemaBaselineHashFileContent,
  renderSqliteSessionSchemaBaseline,
  writeSqliteSessionSchemaBaselineArtifacts,
} from "../../scripts/lib/sqlite-session-schema-baseline.ts";

describe("SQLite sessions/transcripts schema baseline", () => {
  it("includes session and transcript DDL while excluding unrelated agent tables", async () => {
    const sourceSql = await readFile("src/state/openclaw-agent-schema.sql", "utf8");

    const rendered = renderSqliteSessionSchemaBaseline(sourceSql);

    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS session_nodes");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS session_windows");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS transcript_events");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS transcript_event_identities");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS session_transcript_active_events");
    expect(rendered.sql).not.toContain("idx_agent_transcript_events_session");
    for (const table of ["cache_entries", "auth_profile_store", "memory_index_sources"]) {
      expect(rendered.sql).not.toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("automatically includes new indexes declared on target tables", () => {
    const rendered = renderSqliteSessionSchemaBaseline(`
      CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT NOT NULL PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_custom ON session_nodes(session_key);
      CREATE INDEX IF NOT EXISTS idx_agent_cache_custom ON cache_entries(scope);
    `);

    expect(rendered.sql).toContain("CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_custom");
    expect(rendered.sql).not.toContain("idx_agent_cache_custom");
  });

  it("checks generated SQL and hash artifacts for drift", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-schema-baseline-"));
    const schemaPath = path.join(tmp, "schema.sql");
    const sqlPath = path.join(tmp, "baseline.sql");
    const hashPath = path.join(tmp, "baseline.sha256");
    const generate = (check: boolean) =>
      writeSqliteSessionSchemaBaselineArtifacts({
        repoRoot: tmp,
        check,
        schemaInputPath: "schema.sql",
        sqlOutputPath: "baseline.sql",
        hashOutputPath: "baseline.sha256",
      });
    await writeFile(
      schemaPath,
      "CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT NOT NULL PRIMARY KEY);",
    );

    expect(await generate(false)).toMatchObject({ changed: true, wrote: true });
    expect((await generate(true)).changed).toBe(false);
    const generatedSql = await readFile(sqlPath, "utf8");
    await rm(sqlPath);
    expect((await generate(true)).changed).toBe(false);
    await writeFile(hashPath, "stale\n");
    expect((await generate(true)).changed).toBe(true);
    expect(await readFile(hashPath, "utf8")).not.toBe(
      computeSqliteSessionSchemaBaselineHashFileContent({
        sql: generatedSql,
      }),
    );
  });
});
