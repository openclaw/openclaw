import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SystemRunApprovalFileOperand } from "./exec-approvals-core.js";

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
    sha256 = sha256Hex(fs.readFileSync(realPath));
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

export function revalidateApprovedMutableFileOperand(params: {
  snapshot: SystemRunApprovalFileOperand;
  argv: string[];
  cwd: string | undefined;
}): boolean {
  const operand = params.argv[params.snapshot.argvIndex]?.trim();
  if (!operand) {
    return false;
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(path.resolve(params.cwd ?? process.cwd(), operand));
  } catch {
    return false;
  }
  if (realPath !== params.snapshot.path) {
    return false;
  }
  try {
    return sha256Hex(fs.readFileSync(realPath)) === params.snapshot.sha256;
  } catch {
    return false;
  }
}
