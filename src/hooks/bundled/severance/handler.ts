import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import { applySeveranceOverride, resolveSeveranceConfigFromHook } from "../../severance.js";

const HOOK_KEY = "severance";

const severanceHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  if (context.sessionKey && isSubagentSessionKey(context.sessionKey)) {
    return;
  }
  const cfg = context.cfg;
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const severanceConfig = resolveSeveranceConfigFromHook(hookConfig as Record<string, unknown>, {
    warn: (message) => console.warn(`[severance] ${message}`),
  });
  if (!severanceConfig) {
    return;
  }

  const workspaceDir = context.workspaceDir;
  if (!workspaceDir || !Array.isArray(context.bootstrapFiles)) {
    return;
  }

  const updated = await applySeveranceOverride({
    files: context.bootstrapFiles,
    workspaceDir,
    config: severanceConfig,
    userTimezone: cfg?.agents?.defaults?.userTimezone,
    log: {
      warn: (message) => console.warn(`[severance] ${message}`),
      debug: (message) => console.debug?.(`[severance] ${message}`),
    },
  });

  context.bootstrapFiles = updated;
};

export default severanceHook;
