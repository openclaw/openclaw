/**
 * Gateway integration for AutomationsService.
 *
 * Creates and manages the AutomationService instance for the gateway,
 * following the same pattern as CronService.
 */

import type { CliDeps } from "../cli/deps.js";
import type { CronJob, CronJobState } from "../cron/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { ArtifactStorage, resolveArtifactsDir } from "../automations/artifacts.js";
import { AutomationService } from "../automations/service.js";
import { resolveAutomationsStorePath } from "../automations/store.js";
import { loadConfig } from "../config/config.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Gateway automation state.
 */
export type GatewayAutomationsState = {
  automations: AutomationService;
  artifactStorage: ArtifactStorage;
  storePath: string;
  automationsEnabled: boolean;
};

/**
 * Build the automations service for gateway integration.
 *
 * @param params - Configuration and dependencies
 * @returns Gateway automations state
 */
export function buildGatewayAutomationsService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayAutomationsState {
  // Use automations config if available, otherwise default to enabled
  const automationsCfg = (params.cfg as { automations?: { enabled?: boolean; store?: string } })
    .automations;
  const storePath = resolveAutomationsStorePath(automationsCfg?.store);
  const automationsEnabled =
    process.env.CLAWDBRAIN_SKIP_AUTOMATIONS !== "1" && automationsCfg?.enabled !== false;

  const resolveAutomationAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const automations = new AutomationService({
    storePath,
    automationsEnabled,
    emitAutomationEvent: (evt) => {
      params.broadcast("automations", evt, { dropIfSlow: true });
    },
    runIsolatedAgentJob: async ({ automation, message }) => {
      const { agentId, cfg: runtimeConfig } = resolveAutomationAgent(automation.agentId);
      // Reuse cron's isolated agent runner for automations
      // Create a compatible CronJob structure with proper CronJobState
      const state: CronJobState = {
        nextRunAtMs: automation.state.nextRunAtMs,
        runningAtMs: automation.state.runningAtMs,
        lastRunAtMs: automation.state.lastRunAtMs,
        // Map automation status to cron job status
        lastStatus:
          automation.state.lastStatus === "error"
            ? "error"
            : automation.state.lastStatus === "success"
              ? "ok"
              : automation.state.lastStatus === "cancelled"
                ? "skipped"
                : automation.state.lastStatus === "blocked"
                  ? "error"
                  : undefined,
        lastError: automation.state.lastError,
        lastDurationMs: automation.state.lastDurationMs,
      };
      // Convert AutomationSchedule to CronSchedule
      const cronSchedule: CronJob["schedule"] =
        automation.schedule.kind === "at"
          ? { kind: "at", at: new Date(automation.schedule.atMs).toISOString() }
          : automation.schedule;
      const job: CronJob = {
        id: automation.id,
        agentId,
        name: automation.name,
        description: automation.description,
        enabled: automation.enabled,
        createdAtMs: automation.createdAtMs,
        updatedAtMs: automation.updatedAtMs,
        schedule: cronSchedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message,
        },
        delivery: {
          mode: "announce",
        },
        state,
      };
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        agentId,
        sessionKey: `automation:${automation.id}`,
        lane: "automations",
      });
    },
    log: getChildLogger({ module: "automations", storePath }),
    onEvent: (evt) => {
      params.broadcast("automations", evt, { dropIfSlow: true });
    },
  });

  // Initialize artifact storage
  const artifactsDir = resolveArtifactsDir(
    (automationsCfg as { artifactsDir?: string })?.artifactsDir,
  );
  const artifactStorage = new ArtifactStorage({
    artifactsDir,
    baseUrl: "/api/automations/artifacts",
  });

  return { automations, artifactStorage, storePath, automationsEnabled };
}
