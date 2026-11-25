/** Captures and revalidates the directory identity used by exec authorization. */
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { realpathForExec } from "./exec-command-resolution.js";
import { hasMutableSymlinkPathComponent } from "./system-run-mutable-file-policy.js";

export const APPROVAL_CWD_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval cwd changed before execution";

export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.BigIntStats;
};

export async function captureApprovedCwdSnapshot(
  cwd: string,
): Promise<{ ok: true; snapshot: ApprovedCwdSnapshot } | { ok: false; message: string }> {
  const requestedCwd = path.resolve(cwd);
  let cwdLstat: fs.BigIntStats;
  let cwdStat: fs.BigIntStats;
  let cwdReal: string;
  let cwdRealStat: fs.BigIntStats;
  try {
    cwdLstat = await fsp.lstat(requestedCwd, { bigint: true });
    cwdStat = await fsp.stat(requestedCwd, { bigint: true });
    cwdReal = await realpathForExec(requestedCwd);
    cwdRealStat = await fsp.stat(cwdReal, { bigint: true });
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing, resolved working directory",
    };
  }
  if (!cwdStat.isDirectory()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory",
    };
  }
  if ((await hasMutableSymlinkPathComponent(requestedCwd)) || cwdLstat.isSymbolicLink()) {
    return {
      ok: false,
      message:
        "SYSTEM_RUN_DENIED: approval requires a working directory without symlink path components",
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
export async function revalidateApprovedCwdSnapshot(
  snapshot: ApprovedCwdSnapshot,
): Promise<boolean> {
  const current = await captureApprovedCwdSnapshot(snapshot.cwd);
  return current.ok && sameFileIdentity(snapshot.stat, current.snapshot.stat);
}
