import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { expandHomePrefix } from "../../../infra/home-dir.js";
import {
  normalizePluginBindingApprovalsForMigration,
  writePluginBindingApprovalsForMigration,
} from "../../../plugins/conversation-binding.js";

const LEGACY_APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";

function resolveLegacyApprovalsPath(): string {
  if (process.env.OPENCLAW_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(process.env), "plugin-binding-approvals.json");
  }
  return expandHomePrefix(LEGACY_APPROVALS_PATH);
}

export function legacyPluginBindingApprovalFileExists(): boolean {
  try {
    return fs.statSync(resolveLegacyApprovalsPath()).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacyPluginBindingApprovalFileToSqlite(): {
  imported: boolean;
  approvals: number;
} {
  const filePath = resolveLegacyApprovalsPath();
  if (!legacyPluginBindingApprovalFileExists()) {
    return { imported: false, approvals: 0 };
  }
  const file = normalizePluginBindingApprovalsForMigration(
    JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown,
  );
  writePluginBindingApprovalsForMigration(file);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, approvals: file.approvals.length };
}
