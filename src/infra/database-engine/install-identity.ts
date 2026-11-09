// Installation identity for database.localStores none; PostgreSQL install rows key on it.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../errno.js";

const INSTALLATION_FILE = "postgres-install.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fixed install schema beside the per-store namespaces. */
export function installSchemaName(schemaPrefix: string): string {
  return `${schemaPrefix}_install`;
}

/** One installation UUID per state dir: created once, never rewritten. */
export function readOrCreateInstallationId(stateDir: string): string {
  const file = path.join(stateDir, INSTALLATION_FILE);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const id =
      parsed && typeof parsed === "object" && "installationId" in parsed
        ? parsed.installationId
        : undefined;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new Error(
        `Invalid PostgreSQL installation identity at ${file}; restore it from backup.`,
      );
    }
    return id;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(staged, `${JSON.stringify({ installationId: randomUUID() })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    // link() publishes atomically and never replaces a concurrent winner.
    fs.linkSync(staged, file);
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return readOrCreateInstallationId(stateDir);
}
