import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectClaworksLaunchAgentPortConflict,
  detectMisplacedOpenClawLaunchAgent,
} from "../config/claworks-product-guard.js";

function repoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function runLaunchctl(args: string[]): boolean {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return result.status === 0;
}

export type ClaworksLaunchAgentRepairResult = {
  changes: string[];
  warnings: string[];
};

/** Remove misplaced OpenClaw LaunchAgent and reinstall ClaWorks gateway service on macOS. */
export function repairClaworksLaunchAgentIsolation(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean },
): ClaworksLaunchAgentRepairResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (process.platform !== "darwin") {
    return { changes, warnings: ["LaunchAgent repair skipped: not macOS"] };
  }

  const misplaced = detectMisplacedOpenClawLaunchAgent(env);
  const portConflict = detectClaworksLaunchAgentPortConflict(env);
  if (!misplaced && !portConflict) {
    return { changes, warnings };
  }

  const dryRun = opts?.dryRun === true;
  if (misplaced) {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "501";
    const plist = path.join(os.homedir(), "Library/LaunchAgents", `${misplaced}.plist`);
    if (dryRun) {
      changes.push(`Would remove misplaced LaunchAgent ${misplaced}`);
    } else {
      runLaunchctl(["bootout", `gui/${uid}/${misplaced}`]);
      runLaunchctl(["unload", plist]);
      try {
        fs.unlinkSync(plist);
      } catch {
        // ignore missing plist
      }
      changes.push(`Removed misplaced LaunchAgent ${misplaced}`);
    }
  }

  if (!misplaced && !portConflict) {
    return { changes, warnings };
  }

  if (dryRun) {
    changes.push("Would reinstall ai.claworks.gateway on port 18800");
    return { changes, warnings };
  }

  const root = repoRootFromModule();
  const cli = fs.existsSync(path.join(root, "claworks.mjs"))
    ? path.join(root, "claworks.mjs")
    : path.join(root, "openclaw.mjs");
  const installEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    CLAWORKS_PRODUCT: "1",
    _CLAWORKS_ARGV1: "claworks.mjs",
  };
  const result = spawnSync(process.execPath, [cli, "gateway", "install", "--force"], {
    env: installEnv,
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || "unknown error";
    warnings.push(`gateway install --force failed: ${detail}`);
    warnings.push("Try manually: pnpm claworks:isolate");
  } else {
    changes.push("Reinstalled ai.claworks.gateway on port 18800");
  }

  return { changes, warnings };
}
