import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

export function ensureEmbeddedHistoryRuntimePluginsLoaded(params: {
  cfg: OpenClawConfig;
  sessionAgentId: string;
}): { status: "warmed" } | { status: "failed"; error: string } {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId);
    loadAgentRuntimePluginRegistryHandle({
      config: params.cfg,
      workspaceDir,
    });
    return { status: "warmed" };
  } catch (err) {
    return { status: "failed", error: formatTuiErrorMessage(err) };
  }
}
