import crypto from "node:crypto";
import fs from "node:fs";
import type { SystemRunApprovalFileOperand } from "./exec-approvals.js";

export function hashFileContentsSync(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function snapshotFileOperandAtPath(params: {
  argvIndex: number;
  filePath: string;
}): { ok: true; snapshot: SystemRunApprovalFileOperand } | { ok: false; message: string } {
  let realPath: string;
  let stat: fs.Stats;
  try {
    realPath = fs.realpathSync(params.filePath);
    stat = fs.statSync(realPath);
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing script operand",
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a file script operand",
    };
  }
  let sha256: string;
  try {
    sha256 = hashFileContentsSync(realPath);
  } catch {
    // An unreadable script has no approved byte identity. Treating it as
    // unbound would let later readable bytes execute under this approval.
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a readable script operand",
    };
  }
  return { ok: true, snapshot: { argvIndex: params.argvIndex, path: realPath, sha256 } };
}
