import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { readBackupEngine } from "./database-engine/physical-store.js";
import { updateDoctorMigrationContext } from "./update-doctor-migration-context.js";

/** Suppress a second capture only when this anchor selects a protected server copy. */
export function isPrivateDoctorPostgresStore(sourcePath: string): boolean {
  const liveRoot = updateDoctorMigrationContext.getStore()?.stateUpgradeLiveStateDir;
  if (liveRoot === undefined) {
    return false;
  }
  const relative = path.relative(resolveStateDir(), sourcePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const originalPath = path.join(liveRoot, relative);
  if (!fs.existsSync(originalPath)) {
    return false;
  }
  const original = readBackupEngine(originalPath);
  const candidate = readBackupEngine(sourcePath);
  return (
    original.engine === "postgres" &&
    candidate.engine === "postgres" &&
    original.storeId === candidate.storeId &&
    original.namespace !== candidate.namespace
  );
}
