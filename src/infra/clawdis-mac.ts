import fs from "node:fs";
import path from "node:path";

import { runCommandWithTimeout, runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type ClawdisMacExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function isFileExecutable(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClawdisMacBinary(
  runtime: RuntimeEnv = defaultRuntime,
): Promise<string> {
  if (process.platform !== "darwin") {
    runtime.error("clawdis-mac is only available on macOS.");
    runtime.exit(1);
  }

  const override = process.env.CLAWDIS_MAC_BIN?.trim();
  if (override) return override;

  try {
    const { stdout } = await runExec("which", ["clawdis-mac"], 2000);
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // fall through
  }

  const local = path.resolve(process.cwd(), "bin", "clawdis-mac");
  if (isFileExecutable(local)) return local;

  runtime.error(
    "Missing required binary: clawdis-mac. Install the Clawdis mac app/CLI helper (or set CLAWDIS_MAC_BIN).",
  );
  runtime.exit(1);
}

export async function runClawdisMac(
  args: string[],
  opts?: { json?: boolean; timeoutMs?: number; runtime?: RuntimeEnv },
): Promise<ClawdisMacExecResult> {
  const runtime = opts?.runtime ?? defaultRuntime;
  const cmd = await resolveClawdisMacBinary(runtime);

  const argv: string[] = [cmd];
  if (opts?.json) argv.push("--json");
  argv.push(...args);

  const res = await runCommandWithTimeout(argv, opts?.timeoutMs ?? 30_000);
  return { stdout: res.stdout, stderr: res.stderr, code: res.code };
}

