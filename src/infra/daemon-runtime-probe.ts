import path from "node:path";
import { probeSqlite } from "../../node-sqlite-capabilities.mjs";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";

export async function readRuntimeProbeInfo(runtime: "node" | "bun", standaloneRoot?: string) {
  let sqliteVersion: string | null = null;
  let sqliteSelectionError: string | null = null;
  let sqliteLibraryPath: string | null = null;
  let sqliteProbe: ReturnType<typeof probeSqlite> = {
    available: false,
    version: null,
    text: false,
    blob: false,
    json: false,
  };
  if (runtime === "bun") {
    try {
      const selection = ensureSqliteLibrarySelected({ standaloneRoot });
      if ("path" in selection) {
        sqliteLibraryPath = path.resolve(selection.path);
      }
    } catch (error) {
      sqliteSelectionError = error instanceof Error ? error.message : String(error);
    }
  }
  if (sqliteSelectionError === null) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      sqliteProbe = probeSqlite(DatabaseSync);
      sqliteVersion = sqliteProbe.version;
    } catch {
      // An unavailable built-in is a capability result, not a failed process launch.
    }
  }
  // Node exposes this configure flag, but @types/node omits it from ProcessConfig.
  const variables:
    | (NodeJS.ProcessConfig["variables"] & {
        readonly node_shared_sqlite?: boolean | string;
      })
    | undefined = process.config?.variables;
  const sharedSqlite = variables?.node_shared_sqlite;
  const nodeSharedSqlite = sharedSqlite === true || sharedSqlite === "true";
  return {
    nodeVersion: process.versions.node,
    bunVersion: process.versions.bun ?? null,
    sqliteVersion,
    sqliteProbe,
    sqliteSelectionError,
    sqliteLibraryPath,
    nodeSharedSqlite,
  };
}
