/**
 * AI Fabric Wizard Step
 *
 * Interactive and non-interactive setup for Cloud.ru AI Fabric
 * MCP server auto-discovery and configuration.
 *
 * Inserted into the Cloud.ru FM onboarding flow after proxy auto-start.
 * Uses IAM token exchange (keyId + secret) for authentication.
 */

import type { CloudruAuthConfig, McpServer, Agent } from "../ai-fabric/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AiFabricAgentEntry } from "../config/types.ai-fabric.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { CloudruAuthError } from "../ai-fabric/cloudru-auth.js";
import { CloudruSimpleClient } from "../ai-fabric/cloudru-client-simple.js";
import { CloudruApiError } from "../ai-fabric/cloudru-client.js";
import { ensureGitignoreEntries } from "./onboard-cloudru-fm.js";
import {
  writeMcpConfigFile,
  appendMcpConfigArgs,
  CLOUDRU_MCP_CONFIG_FILENAME,
} from "./write-mcp-config.js";

export type SetupAiFabricParams = {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  /** IAM credentials for Cloud.ru AI Fabric API. */
  auth: CloudruAuthConfig;
  workspaceDir: string;
};

export type SetupAiFabricResult = {
  config: OpenClawConfig;
  /** Whether AI Fabric was configured (user accepted + servers found). */
  configured: boolean;
};

/**
 * Interactive AI Fabric setup wizard step.
 *
 * Flow:
 * 1. Confirm: "Connect AI Fabric MCP servers?"
 * 2. Collect project ID
 * 3. Discover MCP servers from Cloud.ru API
 * 4. Multi-select servers to connect
 * 5. Write MCP config file
 * 6. Update config (aiFabric + cli backend args)
 * 7. Update .gitignore
 */
export async function setupAiFabric(params: SetupAiFabricParams): Promise<SetupAiFabricResult> {
  const { prompter, auth, workspaceDir } = params;
  let config = params.config;

  const wantsFabric = await prompter.confirm({
    message: "Connect Cloud.ru AI Fabric MCP servers?",
    initialValue: false,
  });

  if (!wantsFabric) {
    return { config, configured: false };
  }

  const projectId = await prompter.text({
    message: "Cloud.ru AI Fabric project ID",
    placeholder: "proj-xxxx-xxxx",
    validate: (v) => (v.trim() ? undefined : "Project ID is required"),
  });

  const trimmedProjectId = projectId.trim();
  const client = new CloudruSimpleClient({ projectId: trimmedProjectId, auth });

  // --- MCP Server Discovery ---
  const servers = await discoverMcpServers({ client, prompter });
  let mcpConfigPath: string | undefined;

  if (servers && servers.length > 0) {
    const options = servers.map((s) => ({
      value: s,
      label: s.name,
      hint: `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} — ${s.status}`,
    }));

    const selected = await prompter.multiselect<McpServer>({
      message: `Select MCP servers to connect (${servers.length} available)`,
      options,
      initialValues: servers.filter((s) => s.status === "RUNNING" || s.status === "AVAILABLE"),
    });

    if (selected.length > 0) {
      mcpConfigPath = await writeMcpConfigFile({ workspaceDir, servers: selected });
      await ensureGitignoreEntries({ workspaceDir, entries: [CLOUDRU_MCP_CONFIG_FILENAME] });

      const toolCount = selected.reduce((sum, s) => sum + s.tools.length, 0);
      await prompter.note(
        `Connected ${selected.length} MCP server${selected.length === 1 ? "" : "s"} (${toolCount} tools).\n` +
          `Config: ${CLOUDRU_MCP_CONFIG_FILENAME}`,
        "AI Fabric — MCP",
      );
    }
  } else {
    await prompter.note(
      "No MCP servers found in this project. You can add them later in Cloud.ru console.",
      "AI Fabric",
    );
  }

  // --- Agent Discovery ---
  const agents = await discoverAgents({ client, prompter });
  let selectedAgents: AiFabricAgentEntry[] | undefined;

  if (agents.length > 0) {
    const agentOptions = agents.map((a) => ({
      value: a,
      label: a.name,
      hint: a.endpoint,
    }));

    selectedAgents = await prompter.multiselect<AiFabricAgentEntry>({
      message: `Select AI Agents for A2A communication (${agents.length} available)`,
      options: agentOptions,
      initialValues: agents,
    });

    if (selectedAgents.length > 0) {
      await prompter.note(
        `Selected ${selectedAgents.length} agent${selectedAgents.length === 1 ? "" : "s"} for A2A.`,
        "AI Fabric — Agents",
      );
    }
  }

  // --- Apply Config ---
  config = applyAiFabricConfig(config, {
    projectId: trimmedProjectId,
    keyId: auth.keyId,
    mcpConfigPath,
    agents: selectedAgents,
  });
  if (mcpConfigPath) {
    config = applyMcpArgsToCliBackend(config, mcpConfigPath);
  }

  const configured = !!mcpConfigPath || (selectedAgents != null && selectedAgents.length > 0);
  return { config, configured };
}

export type SetupAiFabricNonInteractiveParams = {
  config: OpenClawConfig;
  /** IAM credentials for Cloud.ru AI Fabric API. */
  auth: CloudruAuthConfig;
  projectId: string;
  workspaceDir: string;
};

/**
 * Non-interactive AI Fabric setup.
 * Auto-connects all available (RUNNING/AVAILABLE) MCP servers.
 */
export async function setupAiFabricNonInteractive(
  params: SetupAiFabricNonInteractiveParams,
): Promise<SetupAiFabricResult> {
  const { auth, projectId, workspaceDir } = params;
  let config = params.config;

  const client = new CloudruSimpleClient({ projectId, auth });

  // --- MCP Servers ---
  let mcpConfigPath: string | undefined;
  try {
    const result = await client.listMcpServers();
    const servers = result.items.filter((s) => s.status === "RUNNING" || s.status === "AVAILABLE");
    if (servers.length > 0) {
      mcpConfigPath = await writeMcpConfigFile({ workspaceDir, servers });
      await ensureGitignoreEntries({ workspaceDir, entries: [CLOUDRU_MCP_CONFIG_FILENAME] });
    }
  } catch {
    // MCP discovery failed — continue with agent discovery
  }

  // --- Agents ---
  let agents: AiFabricAgentEntry[] | undefined;
  try {
    const result = await client.listAgents({ status: "RUNNING" });
    agents = result.items
      .filter((a): a is Agent & { endpoint: string } => a.endpoint != null)
      .map((a) => ({ id: a.id, name: a.name, endpoint: a.endpoint }));
    if (agents.length === 0) {
      agents = undefined;
    }
  } catch {
    // Agent discovery failed — continue
  }

  config = applyAiFabricConfig(config, { projectId, keyId: auth.keyId, mcpConfigPath, agents });
  if (mcpConfigPath) {
    config = applyMcpArgsToCliBackend(config, mcpConfigPath);
  }

  const configured = !!mcpConfigPath || agents != null;
  return { config, configured };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function discoverMcpServers(params: {
  client: CloudruSimpleClient;
  prompter: WizardPrompter;
}): Promise<McpServer[] | null> {
  const spinner = params.prompter.progress("Discovering MCP servers...");
  try {
    const result = await params.client.listMcpServers();
    spinner.stop(`Found ${result.items.length} MCP server${result.items.length === 1 ? "" : "s"}`);
    return result.items;
  } catch (err) {
    const detail =
      err instanceof CloudruAuthError
        ? `IAM auth failed: ${err.message}`
        : err instanceof CloudruApiError
          ? `API error ${err.status}: ${err.message}`
          : String(err);
    spinner.stop("MCP discovery failed");
    await params.prompter.note(
      `Could not list MCP servers: ${detail}\nYou can configure them manually later.`,
      "AI Fabric warning",
    );
    return null;
  }
}

async function discoverAgents(params: {
  client: CloudruSimpleClient;
  prompter: WizardPrompter;
}): Promise<AiFabricAgentEntry[]> {
  const spinner = params.prompter.progress("Discovering AI Agents...");
  try {
    const result = await params.client.listAgents({ status: "RUNNING" });
    const agents = result.items
      .filter((a): a is Agent & { endpoint: string } => a.endpoint != null)
      .map((a) => ({ id: a.id, name: a.name, endpoint: a.endpoint }));
    spinner.stop(
      agents.length > 0
        ? `Found ${agents.length} agent${agents.length === 1 ? "" : "s"}`
        : "No agents found",
    );
    return agents;
  } catch {
    spinner.stop("Agent discovery failed (continuing without agents)");
    return [];
  }
}

function applyAiFabricConfig(
  config: OpenClawConfig,
  params: {
    projectId: string;
    keyId?: string;
    mcpConfigPath?: string;
    agents?: AiFabricAgentEntry[];
  },
): OpenClawConfig {
  return {
    ...config,
    aiFabric: {
      enabled: true,
      projectId: params.projectId,
      ...(params.keyId ? { keyId: params.keyId } : {}),
      ...(params.mcpConfigPath ? { mcpConfigPath: params.mcpConfigPath } : {}),
      ...(params.agents?.length ? { agents: params.agents } : {}),
    },
  };
}

function applyMcpArgsToCliBackend(config: OpenClawConfig, mcpConfigPath: string): OpenClawConfig {
  const existingCliBackends = config.agents?.defaults?.cliBackends ?? {};
  const existingClaudeCli = existingCliBackends["claude-cli"] ?? {};
  const existingArgs = (existingClaudeCli as Record<string, unknown>).args as string[] | undefined;

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        cliBackends: {
          ...existingCliBackends,
          "claude-cli": {
            ...existingClaudeCli,
            args: appendMcpConfigArgs(existingArgs, mcpConfigPath),
          },
        },
      },
    },
  };
}
