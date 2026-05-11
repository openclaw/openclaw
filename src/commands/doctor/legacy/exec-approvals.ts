import fs from "node:fs";
import { writeExecApprovalsRawToSqlite } from "../../../infra/exec-approvals.js";
import { expandHomePrefix } from "../../../infra/home-dir.js";

const LEGACY_EXEC_APPROVALS_FILE = "~/.openclaw/exec-approvals.json";

function readLegacyExecApprovalsRaw(env: NodeJS.ProcessEnv = process.env): {
  raw: string | null;
  exists: boolean;
  path: string;
} {
  const filePath = resolveLegacyExecApprovalsPath(env);
  if (!fs.existsSync(filePath)) {
    return { raw: null, exists: false, path: filePath };
  }
  return { raw: fs.readFileSync(filePath, "utf8"), exists: true, path: filePath };
}

export function resolveLegacyExecApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHomePrefix(LEGACY_EXEC_APPROVALS_FILE, { env });
}

export function legacyExecApprovalsFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return readLegacyExecApprovalsRaw(env).exists;
}

export function importLegacyExecApprovalsFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
} {
  const legacy = readLegacyExecApprovalsRaw(env);
  if (!legacy.exists || legacy.raw === null) {
    return { imported: false };
  }
  writeExecApprovalsRawToSqlite(legacy.raw, env);
  fs.rmSync(legacy.path, { force: true });
  return { imported: true };
}
