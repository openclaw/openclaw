import { listAgentIds, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  DEFAULT_CREATE_DAYS_AHEAD,
  DEFAULT_DAILY_LOG_TEMPLATE,
  ensureDailyLogFiles,
} from "../../../memory/daily-log.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { isAgentBootstrapEvent, isGatewayStartupEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/daily-memory");

function resolveDailyMemoryConfig(cfg: OpenClawConfig | undefined): {
  enabled: boolean;
  template: string;
  createDaysAhead: number;
} {
  const hookConfig = resolveHookConfig(cfg, "daily-memory");
  const template =
    typeof hookConfig?.template === "string" && hookConfig.template.length > 0
      ? hookConfig.template
      : DEFAULT_DAILY_LOG_TEMPLATE;
  const createDaysAheadRaw = hookConfig?.createDaysAhead;
  const createDaysAhead =
    typeof createDaysAheadRaw === "number" &&
    Number.isInteger(createDaysAheadRaw) &&
    createDaysAheadRaw >= 0
      ? createDaysAheadRaw
      : DEFAULT_CREATE_DAYS_AHEAD;

  return {
    enabled: hookConfig?.enabled === true,
    template,
    createDaysAhead,
  };
}

async function ensureLogsForWorkspace(params: {
  workspaceDir: string;
  template: string;
  createDaysAhead: number;
  agentId?: string;
  reason: "agent-bootstrap" | "gateway-startup";
}) {
  const result = await ensureDailyLogFiles({
    workspaceDir: params.workspaceDir,
    template: params.template,
    createDaysAhead: params.createDaysAhead,
  });

  if (result.created > 0) {
    log.info("daily-memory created missing daily logs", {
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      created: result.created,
      reason: params.reason,
    });
    return;
  }

  log.debug("daily-memory found all expected daily logs", {
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    reason: params.reason,
  });
}

const dailyMemoryHook: HookHandler = async (event) => {
  if (isAgentBootstrapEvent(event)) {
    const cfg = event.context.cfg;
    const dailyMemory = resolveDailyMemoryConfig(cfg);
    if (!cfg || !dailyMemory.enabled) {
      return;
    }

    await ensureLogsForWorkspace({
      workspaceDir: event.context.workspaceDir,
      template: dailyMemory.template,
      createDaysAhead: dailyMemory.createDaysAhead,
      agentId: event.context.agentId,
      reason: "agent-bootstrap",
    });
    return;
  }

  if (!isGatewayStartupEvent(event) || !event.context.cfg) {
    return;
  }

  const cfg = event.context.cfg;
  const dailyMemory = resolveDailyMemoryConfig(cfg);
  if (!dailyMemory.enabled) {
    return;
  }

  for (const agentId of listAgentIds(cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    await ensureLogsForWorkspace({
      workspaceDir,
      template: dailyMemory.template,
      createDaysAhead: dailyMemory.createDaysAhead,
      agentId,
      reason: "gateway-startup",
    });
  }
};

export default dailyMemoryHook;
