import type { CliDeps } from "../../../cli/deps.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { runBootOnce } from "../../../gateway/boot.js";

type BootHookContext = {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  deps?: CliDeps;
};

// Rate limiting: Only allow boot to run once per minute to prevent spam
// during rapid gateway restarts (config changes, crashes, or external restarts).
// This ensures BOOT.md is executed at most once even if the gateway restarts
// multiple times in quick succession.
const RATE_LIMIT_MS = 60_000; // 60 seconds
let lastBootTime = 0;

const runBootChecklist: HookHandler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  const context = (event.context ?? {}) as BootHookContext;
  if (!context.cfg || !context.workspaceDir) {
    return;
  }

  // Rate limiting: Skip if boot ran recently
  const now = Date.now();
  if (now - lastBootTime < RATE_LIMIT_MS) {
    return;
  }
  lastBootTime = now;

  const deps = context.deps ?? createDefaultDeps();
  await runBootOnce({ cfg: context.cfg, deps, workspaceDir: context.workspaceDir });
};

export default runBootChecklist;
