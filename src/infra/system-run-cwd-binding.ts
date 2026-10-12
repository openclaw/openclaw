/** Captures and revalidates the directory identity used by exec authorization. */
import fs from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { hasMutableSymlinkPathComponentSync } from "./system-run-mutable-file-policy.js";

export const APPROVAL_CWD_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval cwd changed before execution";

export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.BigIntStats;
};

export function captureApprovedCwdSnapshotSync(
  cwd: string,
): { ok: true; snapshot: ApprovedCwdSnapshot } | { ok: false; message: string } {
  const requestedCwd = path.resolve(cwd);
  let cwdLstat: fs.BigIntStats;
  let cwdStat: fs.BigIntStats;
  let cwdReal: string;
  let cwdRealStat: fs.BigIntStats;
  try {
    cwdLstat = fs.lstatSync(requestedCwd, { bigint: true });
    cwdStat = fs.statSync(requestedCwd, { bigint: true });
    cwdReal = fs.realpathSync(requestedCwd);
    cwdRealStat = fs.statSync(cwdReal, { bigint: true });
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd",
    };
  }
  if (!cwdStat.isDirectory()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory",
    };
  }
  if (hasMutableSymlinkPathComponentSync(requestedCwd) || cwdLstat.isSymbolicLink()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)",
    };
  }
  if (
    !sameFileIdentity(cwdStat, cwdLstat) ||
    !sameFileIdentity(cwdStat, cwdRealStat) ||
    !sameFileIdentity(cwdLstat, cwdRealStat)
  ) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch" };
  }
  return { ok: true, snapshot: { cwd: cwdReal, stat: cwdStat } };
}

/** Rechecks the exact directory object immediately before process launch. */
export function revalidateApprovedCwdSnapshot(snapshot: ApprovedCwdSnapshot): boolean {
  const current = captureApprovedCwdSnapshotSync(snapshot.cwd);
  return current.ok && sameFileIdentity(snapshot.stat, current.snapshot.stat);
}
