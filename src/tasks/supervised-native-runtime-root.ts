import { homedir } from "node:os";
import path from "node:path";
import type { SupervisedTask } from "./supervised-task.types.js";

// Select the native store without relocating auth or creating a new directory.
// Callers retain existence checks and the payload recipe's host-owner/path fence.
export function resolveSupervisedNativeRuntimeRoot(runtime: SupervisedTask["runtime"]): string {
  return runtime === "claude-cli"
    ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"))
    : process.env.CODEX_HOME || path.join(homedir(), ".codex");
}
