import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SystemRunApprovalFileOperand } from "./exec-approvals-core.js";
import { realpathForExec } from "./exec-command-resolution.js";

export async function snapshotFileOperandAtPath(params: {
  argvIndex: number;
  filePath: string;
}): Promise<{ ok: true; snapshot: SystemRunApprovalFileOperand } | { ok: false; message: string }> {
  let realPath: string;
  let stat: fs.Stats;
  try {
    realPath = await realpathForExec(params.filePath);
    stat = await fsp.stat(realPath);
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
    sha256 = sha256Hex(await fsp.readFile(realPath));
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

export async function revalidateApprovedMutableFileOperand(params: {
  snapshot: SystemRunApprovalFileOperand;
  argv: string[];
  cwd: string | undefined;
}): Promise<boolean> {
  const operand = params.argv[params.snapshot.argvIndex]?.trim();
  if (!operand) {
    return false;
  }
  let realPath: string;
  try {
    realPath = await realpathForExec(path.resolve(params.cwd ?? process.cwd(), operand));
  } catch {
    return false;
  }
  if (realPath !== params.snapshot.path) {
    return false;
  }
  try {
    return sha256Hex(await fsp.readFile(realPath)) === params.snapshot.sha256;
  } catch {
    return false;
  }
}
