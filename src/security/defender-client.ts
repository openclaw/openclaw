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
 * Returns { ok: true } on success; { ok: false, stderr } when script exits non-zero or times out.
 * If the script is not present, returns { ok: true } (no defender => skip check).
 */
export async function runDefenderRuntimeMonitor(
  workspaceDir: string,
  subcommand: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ ok: boolean; stderr?: string }> {
  const script = path.join(workspaceDir, "scripts", "runtime-monitor.sh");
  try {
    await fs.access(script);
  } catch {
    return { ok: true };
  }
  try {
    await execFileAsync("bash", [script, subcommand, ...args], {
      env: { ...process.env, OPENCLAW_WORKSPACE: workspaceDir },
      timeout: timeoutMs,
    });
    return { ok: true };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr };
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
): Promise<{ ok: boolean; stderr?: string }> {
  const script = path.join(workspaceDir, "scripts", "audit-skills.sh");
  try {
    await fs.access(script);
  } catch {
    return { ok: true };
  }
  try {
    await execFileAsync("bash", [script, skillDir], {
      env: { ...process.env, OPENCLAW_WORKSPACE: workspaceDir },
      timeout: timeoutMs,
    });
    return { ok: true };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr };
  }
}
