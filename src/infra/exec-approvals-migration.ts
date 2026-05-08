import fs from "node:fs";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { resolveExecApprovalsPath } from "./exec-approvals.js";

const EXEC_APPROVALS_KV_SCOPE = "exec.approvals";
const EXEC_APPROVALS_KV_KEY = "current";

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function readLegacyExecApprovalsRaw(env: NodeJS.ProcessEnv = process.env): {
  raw: string | null;
  exists: boolean;
  path: string;
} {
  const filePath = resolveExecApprovalsPath(env);
  if (!fs.existsSync(filePath)) {
    return { raw: null, exists: false, path: filePath };
  }
  return { raw: fs.readFileSync(filePath, "utf8"), exists: true, path: filePath };
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
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    EXEC_APPROVALS_KV_SCOPE,
    EXEC_APPROVALS_KV_KEY,
    legacy.raw,
    sqliteOptionsForEnv(env),
  );
  fs.rmSync(legacy.path, { force: true });
  return { imported: true };
}
