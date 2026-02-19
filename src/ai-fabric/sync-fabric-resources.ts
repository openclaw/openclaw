/**
 * AI Fabric Resource Sync Orchestrator
 *
 * Top-level orchestrator that syncs Cloud.ru AI Fabric resources
 * to the Claude CLI workspace:
 *
 * 1. MCP servers → claude-mcp-cloudru.json + .claude/settings.json
 * 2. Agents & systems → SKILL.md files in managed skills dir
 * 3. Re-sync → picks up new skills via syncSkillsToClaudeCommands
 *
 * Can be called from:
 * - /status_agents plugin (fire-and-forget after status display)
 * - Gateway startup (best-effort)
 * - `openclaw fabric sync` CLI command
 *
 * Reusable across: plugins, CLI, gateway.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentStatusEntry } from "./agent-status.js";
import type { AgentSystemStatusEntry } from "./agent-system-status.js";
import type { FabricSkillTarget } from "./generate-fabric-skills.js";
import type { McpStatusEntry } from "./mcp-status.js";
import {
  removeFabricMcpFromClaudeSettings,
  syncMcpToClaudeSettings,
  syncSkillsToClaudeCommands,
} from "../agents/skills/claude-commands-sync.js";
import { CLOUDRU_MCP_CONFIG_FILENAME, writeMcpConfigFile } from "../commands/write-mcp-config.js";
import { buildMcpConfig } from "../commands/write-mcp-config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAgentStatus } from "./agent-status.js";
import { getAgentSystemStatus } from "./agent-system-status.js";
import { CloudruTokenProvider } from "./cloudru-auth.js";
import { CloudruSimpleClient } from "./cloudru-client-simple.js";
import { generateFabricSkills } from "./generate-fabric-skills.js";
import { getMcpServerStatus } from "./mcp-status.js";

const log = createSubsystemLogger("fabric-sync");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncFabricParams = {
  config: OpenClawConfig;
  workspaceDir: string;
  projectId: string;
  auth: { keyId: string; secret: string };
  /** Pre-fetched entries (skip API calls if provided). */
  agentEntries?: AgentStatusEntry[];
  mcpEntries?: McpStatusEntry[];
  agentSystemEntries?: AgentSystemStatusEntry[];
};

export type SyncFabricResult =
  | { ok: true; mcpServers: number; skills: number }
  | { ok: false; error: string };

export type DisconnectFabricResult = {
  mcpRemoved: number;
  skillsCleaned: number;
  commandsCleaned: number;
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function syncFabricResources(params: SyncFabricParams): Promise<SyncFabricResult> {
  const { config, workspaceDir, projectId, auth } = params;

  // Fetch status if not pre-supplied
  let agentEntries = params.agentEntries;
  let mcpEntries = params.mcpEntries;
  let systemEntries = params.agentSystemEntries;

  if (!agentEntries || !mcpEntries || !systemEntries) {
    const authParams = { keyId: auth.keyId, secret: auth.secret };
    const [agentResult, mcpResult, systemResult] = await Promise.all([
      agentEntries
        ? Promise.resolve(null)
        : getAgentStatus({
            projectId,
            auth: authParams,
            configuredAgents: config.aiFabric?.agents ?? [],
          }),
      mcpEntries ? Promise.resolve(null) : getMcpServerStatus({ projectId, auth: authParams }),
      systemEntries ? Promise.resolve(null) : getAgentSystemStatus({ projectId, auth: authParams }),
    ]);

    if (!agentEntries && agentResult) {
      agentEntries = agentResult.ok ? agentResult.entries : [];
    }
    if (!mcpEntries && mcpResult) {
      mcpEntries = mcpResult.ok ? mcpResult.entries : [];
    }
    if (!systemEntries && systemResult) {
      systemEntries = systemResult.ok ? systemResult.entries : [];
    }
  }

  agentEntries ??= [];
  mcpEntries ??= [];
  systemEntries ??= [];

  let mcpServerCount = 0;
  let skillCount = 0;

  // Step 1: Sync healthy MCP servers to claude settings (with Bearer auth)
  try {
    const healthyMcp = mcpEntries.filter((e) => e.health === "healthy" || e.health === "degraded");
    if (healthyMcp.length > 0) {
      // Obtain IAM Bearer token for MCP server authentication
      let bearerToken: string | undefined;
      try {
        const tokenProvider = new CloudruTokenProvider(auth);
        const resolved = await tokenProvider.getToken();
        bearerToken = resolved.token;
      } catch (tokenErr) {
        log.warn(`IAM token exchange failed, MCP servers will lack auth: ${String(tokenErr)}`);
      }

      // Write MCP config file
      const mcpServers = healthyMcp.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status as "RUNNING",
        tools: e.tools,
        createdAt: "",
      }));
      const mcpConfigPath = await writeMcpConfigFile({ workspaceDir, servers: mcpServers });
      log.debug(`wrote MCP config: ${mcpConfigPath}`);

      // Merge into .claude/settings.json (with Bearer token for auth)
      const mcpConfig = buildMcpConfig(mcpServers, { bearerToken });
      await syncMcpToClaudeSettings({ workspaceDir, mcpServers: mcpConfig.mcpServers });
      mcpServerCount = healthyMcp.length;
      log.debug(
        `synced ${mcpServerCount} MCP servers to claude settings (auth: ${bearerToken ? "yes" : "no"})`,
      );
    }
  } catch (err) {
    log.warn(`MCP sync failed: ${String(err)}`);
  }

  // Step 2: Generate skills for agents + agent systems
  try {
    const targets = await buildSkillTargets(params, agentEntries, systemEntries);
    const skillsDir = path.join(workspaceDir, "skills");
    const result = await generateFabricSkills({ targets, skillsDir });
    skillCount = result.generated;
    log.debug(`generated ${result.generated} skills, cleaned ${result.cleaned} stale`);
  } catch (err) {
    log.warn(`skill generation failed: ${String(err)}`);
  }

  // Step 3: Re-sync skills to .claude/commands/
  try {
    await syncSkillsToClaudeCommands({ workspaceDir, config });
    log.debug("re-synced skills to claude commands");
  } catch (err) {
    log.warn(`skills re-sync failed: ${String(err)}`);
  }

  return { ok: true, mcpServers: mcpServerCount, skills: skillCount };
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * Disconnect AI Fabric resources from the Claude CLI workspace.
 *
 * Inverse of {@link syncFabricResources}: removes MCP servers from
 * `.claude/settings.json`, cleans generated `fabric-*` skills, and
 * re-syncs commands so stale `.claude/commands/` entries are removed.
 *
 * Reusable across: plugins, CLI, gateway.
 */
export async function disconnectFabricResources(params: {
  workspaceDir: string;
  config: OpenClawConfig;
}): Promise<DisconnectFabricResult> {
  const { workspaceDir, config } = params;
  let mcpRemoved = 0;
  let skillsCleaned = 0;
  let commandsCleaned = 0;

  // Step 1: Remove MCP servers from .claude/settings.json
  try {
    const mcpConfigPath = path.join(workspaceDir, CLOUDRU_MCP_CONFIG_FILENAME);
    const raw = await fsp.readFile(mcpConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const serverNames = Object.keys(parsed.mcpServers ?? {});

    if (serverNames.length > 0) {
      mcpRemoved = await removeFabricMcpFromClaudeSettings({ workspaceDir, serverNames });
    }

    // Remove the MCP config file itself
    await fsp.unlink(mcpConfigPath);
    log.debug(`removed MCP config file: ${mcpConfigPath}`);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      log.warn(`MCP cleanup failed: ${String(err)}`);
    }
  }

  // Step 2: Clean all fabric-* skills (empty targets = remove all synced)
  try {
    const skillsDir = path.join(workspaceDir, "skills");
    const result = await generateFabricSkills({ targets: [], skillsDir });
    skillsCleaned = result.cleaned;
    log.debug(`cleaned ${result.cleaned} fabric skills`);
  } catch (err) {
    log.warn(`skills cleanup failed: ${String(err)}`);
  }

  // Step 3: Re-sync commands (stale fabric commands get removed)
  try {
    const before = await countSyncedCommands(workspaceDir);
    await syncSkillsToClaudeCommands({ workspaceDir, config });
    const after = await countSyncedCommands(workspaceDir);
    commandsCleaned = Math.max(0, before - after);
    log.debug(`cleaned ${commandsCleaned} synced commands`);
  } catch (err) {
    log.warn(`commands cleanup failed: ${String(err)}`);
  }

  return { mcpRemoved, skillsCleaned, commandsCleaned };
}

// ---------------------------------------------------------------------------
// Connection status (read-only filesystem check)
// ---------------------------------------------------------------------------

export type FabricConnectionStatus = {
  connected: boolean;
  mcpServers: number;
  skills: number;
  commands: number;
};

/**
 * Check whether AI Fabric resources are currently connected to the
 * Claude CLI workspace. Pure read-only — no API calls, no side-effects.
 *
 * Reusable across: plugins, CLI, gateway, health checks.
 */
export async function getFabricConnectionStatus(params: {
  workspaceDir: string;
}): Promise<FabricConnectionStatus> {
  const { workspaceDir } = params;

  const [mcpServers, skills, commands] = await Promise.all([
    countMcpInSettings(workspaceDir),
    countFabricSkills(workspaceDir),
    countSyncedCommands(workspaceDir),
  ]);

  return {
    connected: mcpServers > 0 || skills > 0 || commands > 0,
    mcpServers,
    skills,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

async function countSyncedCommands(workspaceDir: string): Promise<number> {
  const { SYNC_MARKER } = await import("../agents/skills/claude-commands-sync.js");
  const commandsDir = path.join(workspaceDir, ".claude", "commands");
  let count = 0;
  try {
    const files = await fsp.readdir(commandsDir);
    for (const file of files) {
      if (!file.endsWith(".md")) {
        continue;
      }
      const content = await fsp.readFile(path.join(commandsDir, file), "utf-8");
      if (content.startsWith(SYNC_MARKER)) {
        count++;
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return count;
}

async function countMcpInSettings(workspaceDir: string): Promise<number> {
  const settingsPath = path.join(workspaceDir, ".claude", "settings.json");
  try {
    const raw = await fsp.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {}).length;
  } catch {
    return 0;
  }
}

async function countFabricSkills(workspaceDir: string): Promise<number> {
  const skillsDir = path.join(workspaceDir, "skills");
  try {
    const entries = await fsp.readdir(skillsDir);
    return entries.filter((e) => e.startsWith("fabric-")).length;
  } catch {
    return 0;
  }
}

async function buildSkillTargets(
  params: SyncFabricParams,
  agentEntries: AgentStatusEntry[],
  systemEntries: AgentSystemStatusEntry[],
): Promise<FabricSkillTarget[]> {
  const targets: FabricSkillTarget[] = [];
  const activeAgents = agentEntries.filter(
    (e) => e.health === "healthy" || e.health === "degraded",
  );
  const activeSystems = systemEntries.filter(
    (e) => e.health === "healthy" || e.health === "degraded",
  );

  // Try to enrich with detailed info (system prompts, tools)
  let client: CloudruSimpleClient | null = null;
  if (activeAgents.length > 0 || activeSystems.length > 0) {
    client = new CloudruSimpleClient({
      projectId: params.projectId,
      auth: params.auth,
    });
  }

  // Agents
  for (const entry of activeAgents) {
    const target: FabricSkillTarget = {
      id: entry.id,
      name: entry.name,
      kind: "agent",
    };

    // Try to fetch full agent details for systemPrompt + tools
    if (client) {
      try {
        const full = await client.getAgent(entry.id);
        target.description = full.description;
        target.systemPrompt = full.options?.systemPrompt;
        target.tools = full.options?.tools;
      } catch {
        // Use basic info from status entry
      }
    }

    targets.push(target);
  }

  // Agent Systems
  for (const entry of activeSystems) {
    const target: FabricSkillTarget = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: "agent-system",
      memberCount: entry.memberCount,
    };

    if (client) {
      try {
        const full = await client.getAgentSystem(entry.id);
        target.description = full.description;
      } catch {
        // Use basic info
      }
    }

    targets.push(target);
  }

  return targets;
}
