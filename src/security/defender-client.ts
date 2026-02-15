import { execFile } from "node:child_process";
/**
 * OpenClaw Defender integration client.
 * Optional: when openclaw-defender skill is present in workspace, these helpers
 * gate tool dispatch (kill switch), skill install (audit), exec (check-command),
 * and network (check-network). See openclaw-defender references for protocol.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileError = Error & { stdout?: string; stderr?: string; killed?: boolean; code?: number };

function normalizeExecError(err: unknown): { stderr: string; timedOut: boolean } {
  const e = err as ExecFileError;
  const stderr =
    (typeof e.stderr === "string" && e.stderr.trim()) ||
    (typeof e.stdout === "string" && e.stdout.trim()) ||
    (err instanceof Error ? err.message : String(err));
  return { stderr, timedOut: e.killed === true };
}

/** Defender skill dir name under workspace/skills/; scripts live at skills/<name>/scripts/ */
const DEFENDER_SKILL_DIR = "openclaw-defender";

function resolveDefenderScriptsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", DEFENDER_SKILL_DIR, "scripts");
}

export function resolveDefenderWorkspace(override?: string): string {
  return (
    override?.trim() ||
    process.env.OPENCLAW_WORKSPACE?.trim() ||
    path.join(os.homedir(), ".openclaw", "workspace")
  );
}

/**
 * Returns true if workspace has .kill-switch (all tool ops should be refused).
 */
export async function isKillSwitchActive(workspaceDir: string): Promise<boolean> {
  const p = path.join(workspaceDir, ".kill-switch");
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Run runtime-monitor.sh with the given subcommand and args.
 * Returns { ok: true } on success; { ok: false, stderr, timedOut? } when script exits non-zero or times out.
 * If the script is not present, returns { ok: true } (no defender => skip check).
 */
export async function runDefenderRuntimeMonitor(
  workspaceDir: string,
  subcommand: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ ok: boolean; stderr?: string; timedOut?: boolean }> {
  const script = path.join(resolveDefenderScriptsDir(workspaceDir), "runtime-monitor.sh");
  try {
    await fs.access(script);
  } catch {
    return { ok: true };
  }
  try {
    await execFileAsync("bash", [script, subcommand, ...args], {
      env: { ...process.env, OPENCLAW_WORKSPACE: workspaceDir },
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return { ok: true };
  } catch (err) {
    const { stderr, timedOut } = normalizeExecError(err);
    return { ok: false, stderr, ...(timedOut && { timedOut: true }) };
  }
}

/**
 * Run audit-skills.sh on a skill directory. Returns { ok: true } if audit passes.
 * If script is not present, returns { ok: true } (no defender => skip audit gate).
 */
export async function runDefenderAudit(
  workspaceDir: string,
  skillDir: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stderr?: string; timedOut?: boolean }> {
  const script = path.join(resolveDefenderScriptsDir(workspaceDir), "audit-skills.sh");
  try {
    await fs.access(script);
  } catch {
    return { ok: true };
  }
  try {
    await execFileAsync("bash", [script, skillDir], {
      env: { ...process.env, OPENCLAW_WORKSPACE: workspaceDir },
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return { ok: true };
  } catch (err) {
    const { stderr, timedOut } = normalizeExecError(err);
    return { ok: false, stderr, ...(timedOut && { timedOut: true }) };
  }
}
