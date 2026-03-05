import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveWorkspaceTemplateDir } from "../agents/workspace-templates.js";
import { type OpenClawConfig, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { callGatewayCli } from "../gateway/call.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { applyAgentConfig, findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";

type MatrixInitOptions = {
  nonInteractive?: boolean;
  json?: boolean;
  withCron?: boolean;
};

type MatrixAgentEntry = {
  id: string;
  name?: string;
  role?: string;
  department?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  default?: boolean;
  identity?: { emoji?: string; name?: string };
  subagents?: { allowAgents?: string[] };
};

type MatrixTemplate = {
  agents: {
    defaults?: Record<string, unknown>;
    list: MatrixAgentEntry[];
  };
};

type CronDeployResult = {
  maintenance: number;
  sync: number;
  skipped: number;
  error?: string;
};

/** Department heads that get cron jobs */
const DEPARTMENT_HEADS = ["neo", "morpheus", "trinity"] as const;

const MAINTENANCE_CRON_PROMPT =
  "Check memory/YYYY-MM-DD.md files from the last 3 days. If none exist or they are empty, reply HEARTBEAT_OK and stop. Otherwise consolidate key events and decisions into MEMORY.md and remove outdated entries.";

const SYNC_CRON_PROMPT =
  "Check for outbox files in peer and worker workspaces (see AGENTS.md Memory Sync Protocol). If no outbox files exist, reply HEARTBEAT_OK and stop. Otherwise integrate updates into your memory files and clear processed entries.";

/**
 * Apply extended agent fields (role, department, identity, subagents) that
 * applyAgentConfig does not handle. Mutates cfg.agents.list in place.
 */
function enrichAgentEntry(cfg: OpenClawConfig, agentId: string, entry: MatrixAgentEntry): void {
  const list = cfg.agents?.list;
  if (!list) {
    return;
  }
  const index = findAgentEntryIndex(list, agentId);
  if (index < 0) {
    return;
  }
  const target = list[index];
  if (entry.role) {
    target.role = entry.role;
  }
  if (entry.department) {
    target.department = entry.department;
  }
  if (entry.identity) {
    target.identity = { ...target.identity, ...entry.identity };
  }
  if (entry.subagents) {
    target.subagents = { ...target.subagents, ...entry.subagents };
  }
  if (entry.default !== undefined) {
    target.default = entry.default;
  }
}

/**
 * Merge matrix-specific agents.defaults into the config.
 */
function applyMatrixDefaults(
  cfg: OpenClawConfig,
  templateDefaults: Record<string, unknown>,
): OpenClawConfig {
  const existing = cfg.agents?.defaults ?? {};
  // Exclude model/models from template defaults — agents inherit the user's
  // configured model (set during openclaw init/setup), not the template's
  // hardcoded example values.
  const { model: _model, models: _models, ...operationalDefaults } = templateDefaults;
  const merged = {
    ...existing,
    ...operationalDefaults,
    // Deep-merge subagents
    subagents: {
      ...(existing.subagents as Record<string, unknown> | undefined),
      ...(operationalDefaults.subagents as Record<string, unknown> | undefined),
    },
  };
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: merged as OpenClawConfig["agents"] extends { defaults?: infer D } ? D : never,
    },
  };
}

/**
 * Deploy maintenance and sync cron jobs for department heads.
 * Idempotent: skips jobs whose name already exists.
 */
async function deployCronJobs(_runtime: RuntimeEnv): Promise<CronDeployResult> {
  const result: CronDeployResult = { maintenance: 0, sync: 0, skipped: 0 };

  // Fetch existing cron jobs to check for duplicates
  let existingNames: Set<string>;
  try {
    const listResult = await callGatewayCli<{ jobs: Array<{ name: string }> }>({
      method: "cron.list",
      params: { includeDisabled: true },
      timeoutMs: 10_000,
    });
    existingNames = new Set((listResult.jobs ?? []).map((j) => j.name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = `Could not reach gateway: ${msg}`;
    return result;
  }

  for (const agentId of DEPARTMENT_HEADS) {
    const maintenanceName = `matrix:maintenance:${agentId}`;
    const syncName = `matrix:sync:${agentId}`;

    // Deploy maintenance cron (2 AM UTC daily)
    if (existingNames.has(maintenanceName)) {
      result.skipped++;
    } else {
      try {
        await callGatewayCli({
          method: "cron.add",
          params: {
            name: maintenanceName,
            description: `Daily memory maintenance for ${agentId}`,
            enabled: true,
            agentId,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: {
              kind: "agentTurn",
              message: MAINTENANCE_CRON_PROMPT,
            },
            delivery: { mode: "none" },
          },
          timeoutMs: 10_000,
        });
        result.maintenance++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.error = result.error
          ? `${result.error}; ${maintenanceName}: ${msg}`
          : `${maintenanceName}: ${msg}`;
      }
    }

    // Deploy sync cron (3 AM UTC daily)
    if (existingNames.has(syncName)) {
      result.skipped++;
    } else {
      try {
        await callGatewayCli({
          method: "cron.add",
          params: {
            name: syncName,
            description: `Daily inter-agent memory sync for ${agentId}`,
            enabled: true,
            agentId,
            schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: {
              kind: "agentTurn",
              message: SYNC_CRON_PROMPT,
            },
            delivery: { mode: "none" },
          },
          timeoutMs: 10_000,
        });
        result.sync++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.error = result.error
          ? `${result.error}; ${syncName}: ${msg}`
          : `${syncName}: ${msg}`;
      }
    }
  }

  return result;
}

export async function matrixInitCommand(
  opts: MatrixInitOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const jsonOutput = Boolean(opts.json);
  const withCron = Boolean(opts.withCron);

  // 1. Load and validate existing config
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  // 2. Load the matrix template
  const templateDir = await resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, "matrix", "matrix-agents.template.json");

  let template: MatrixTemplate;
  try {
    const raw = await fs.readFile(templatePath, "utf-8");
    template = JSON.parse(raw) as MatrixTemplate;
  } catch {
    runtime.error(`Matrix template not found at ${templatePath}`);
    runtime.exit(1);
    return;
  }

  const templateAgents = template.agents?.list ?? [];
  if (templateAgents.length === 0) {
    runtime.error("Matrix template contains no agents.");
    runtime.exit(1);
    return;
  }

  // 3. Apply matrix defaults (subagent limits, maxSpawnDepth, etc.)
  let nextConfig = cfg;
  if (template.agents?.defaults) {
    nextConfig = applyMatrixDefaults(nextConfig, template.agents.defaults);
  }

  // 4. Add each agent from the template into the config
  const skipped: string[] = [];
  const added: string[] = [];
  for (const entry of templateAgents) {
    const agentId = normalizeAgentId(entry.id);
    const existingList = listAgentEntries(nextConfig);
    const existingIndex = findAgentEntryIndex(existingList, agentId);

    if (existingIndex >= 0) {
      // Agent already exists — enrich with matrix fields but don't overwrite core config
      enrichAgentEntry(nextConfig, agentId, entry);
      skipped.push(agentId);
      continue;
    }

    // Resolve workspace and agentDir
    const workspace = entry.workspace ? resolveUserPath(entry.workspace) : undefined;
    const agentDir = entry.agentDir
      ? resolveUserPath(entry.agentDir)
      : resolveAgentDir(nextConfig, agentId);

    nextConfig = applyAgentConfig(nextConfig, {
      agentId,
      name: entry.name,
      workspace,
      agentDir,
      model: entry.model,
    });

    // Set extended fields not handled by applyAgentConfig
    enrichAgentEntry(nextConfig, agentId, entry);
    added.push(agentId);
  }

  // 5. Write the merged config
  await writeConfigFile(nextConfig);
  if (!jsonOutput) {
    logConfigUpdated(runtime);
  }

  // 6. Ensure workspaces and sessions for all agents
  const workspaceResults: Array<{ id: string; name: string; workspace: string }> = [];
  for (const entry of templateAgents) {
    if (!entry.workspace) {
      continue;
    }
    const resolvedWorkspace = resolveUserPath(entry.workspace);
    const quietRuntime = jsonOutput ? { ...runtime, log: () => {} } : runtime;
    await ensureWorkspaceAndSessions(resolvedWorkspace, quietRuntime, {
      agentId: entry.id,
    });
    workspaceResults.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      workspace: resolvedWorkspace,
    });
  }

  // 7. Deploy cron jobs if requested
  let cronResult: CronDeployResult | undefined;
  if (withCron) {
    cronResult = await deployCronJobs(runtime);
  }

  // 8. Report summary
  if (jsonOutput) {
    const result: Record<string, unknown> = {
      added,
      skipped,
      agents: templateAgents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        department: a.department,
        workspace: a.workspace,
      })),
    };
    if (cronResult) {
      result.cron = cronResult;
    }
    runtime.log(JSON.stringify(result, null, 2));
  } else {
    if (skipped.length > 0) {
      runtime.log(`Skipped ${skipped.length} existing agent(s): ${skipped.join(", ")}`);
    }
    runtime.log("");
    runtime.log(
      `Matrix initialized: ${templateAgents.length} agents configured (${added.length} new, ${skipped.length} existing).`,
    );

    if (cronResult) {
      if (cronResult.error) {
        runtime.log(`Cron deployment warning: ${cronResult.error}`);
      }
      const total = cronResult.maintenance + cronResult.sync;
      if (total > 0 || cronResult.skipped > 0) {
        runtime.log(
          `Cron jobs: ${total} created (${cronResult.maintenance} maintenance, ${cronResult.sync} sync), ${cronResult.skipped} already existed.`,
        );
      }
    }

    runtime.log("Restart the gateway to pick up the new agent hierarchy.");
  }
}
