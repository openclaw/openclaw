import type { CliDeps } from "../../../cli/deps.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { runBootOnce } from "../../../gateway/boot.js";

type BootHookContext = {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  deps?: CliDeps;
};

const runBootChecklist: HookHandler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  const context = (event.context ?? {}) as BootHookContext;
  if (!context.cfg) {
    return;
  }

  const deps = context.deps ?? createDefaultDeps();
  const agentIds = listAgentIds(context.cfg);

  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(context.cfg, agentId);
    await runBootOnce({ cfg: context.cfg, deps, workspaceDir, agentId });
  }
};

export default runBootChecklist;
