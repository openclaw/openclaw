import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";

export function registerStateCommand(program: Command) {
  const state = program
    .command("state")
    .description("Inspect and export the operator1 SQLite state database");

  state
    .command("info")
    .description("Show database location, size, schema version, and table stats")
    .action(async () => {
      const { getStateDbPath, initStateDb, getSchemaVersion, listTables, getTableRowCount } =
        await import("../../infra/state-db/index.js");

      const dbPath = getStateDbPath();
      const exists = fs.existsSync(dbPath);

      if (!exists) {
        console.log(theme.muted("Database does not exist yet. Initializing..."));
      }

      const db = initStateDb();
      const version = getSchemaVersion(db);
      const tables = listTables(db);

      // File size
      let sizeStr = "n/a";
      try {
        const stat = fs.statSync(dbPath);
        sizeStr = formatBytes(stat.size);
      } catch {
        // ignore
      }

      console.log(`\n${theme.heading("State Database")}`);
      console.log(`  Path:            ${dbPath}`);
      console.log(`  Size:            ${sizeStr}`);
      console.log(`  Schema version:  ${version}`);
      console.log(`  Tables:          ${tables.length}`);
      console.log();

      if (tables.length > 0) {
        console.log(theme.heading("Tables:"));
        for (const table of tables) {
          const count = getTableRowCount(db, table);
          console.log(`  ${table.padEnd(30)} ${String(count).padStart(8)} rows`);
        }
        console.log();
      }
    });

  state
    .command("export")
    .description("Export all tables to JSON files for backup/debugging")
    .option("--output <dir>", "Output directory (default: ~/.openclaw/exports/state-{timestamp})")
    .action(async (opts) => {
      const { getStateDbPath, initStateDb, listTables } =
        await import("../../infra/state-db/index.js");

      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) {
        console.log(theme.muted("No state database found. Nothing to export."));
        return;
      }

      const db = initStateDb();
      const tables = listTables(db);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputDir =
        (opts.output as string | undefined) ??
        path.join(path.dirname(dbPath), "exports", `state-${timestamp}`);

      fs.mkdirSync(outputDir, { recursive: true });

      let totalRows = 0;
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        const outPath = path.join(outputDir, `${table}.json`);
        fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
        totalRows += rows.length;
        console.log(`  ${table}: ${rows.length} rows → ${path.basename(outPath)}`);
      }

      console.log(`\n${theme.success(`Exported ${tables.length} tables (${totalRows} rows) to:`)}`);
      console.log(`  ${outputDir}\n`);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
