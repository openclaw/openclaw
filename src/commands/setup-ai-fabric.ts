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
import { describeNetworkError } from "../infra/errors.js";
import { ensureGitignoreEntries } from "./onboard-cloudru-fm.js";
import {
  writeMcpConfigFile,
  writeMcpConfigFromEntries,
  appendMcpConfigArgs,
  CLOUDRU_MCP_CONFIG_FILENAME,
} from "./write-mcp-config.js";

export type SetupAiFabricParams = {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  /** IAM credentials for Cloud.ru AI Fabric API. Omit to skip API discovery (manual-only mode). */
  auth?: CloudruAuthConfig;
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
  const client = auth ? new CloudruSimpleClient({ projectId: trimmedProjectId, auth }) : undefined;

  // --- MCP Server Discovery (API) or Manual Entry ---
  let mcpConfigPath: string | undefined;

  if (client) {
    const servers = await discoverMcpServers({ client, prompter });

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
    } else if (servers) {
      await prompter.note(
        "No MCP servers found in this project. You can add them later in Cloud.ru console.",
        "AI Fabric",
      );
    }
  } else {
    // No IAM credentials — offer manual MCP entry
    const manualEntries = await promptManualMcpServers(prompter);
    if (manualEntries.length > 0) {
      mcpConfigPath = await writeMcpConfigFromEntries({ workspaceDir, entries: manualEntries });
      await ensureGitignoreEntries({ workspaceDir, entries: [CLOUDRU_MCP_CONFIG_FILENAME] });

      await prompter.note(
        `Configured ${manualEntries.length} MCP server${manualEntries.length === 1 ? "" : "s"} (manual).\n` +
          `Config: ${CLOUDRU_MCP_CONFIG_FILENAME}`,
        "AI Fabric — MCP",
      );
    }
  }

  // --- Agent Discovery (API) or Manual Entry ---
  let selectedAgents: AiFabricAgentEntry[] | undefined;

  if (client) {
    const agents = await discoverAgents({ client, prompter });

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
  } else {
    // No IAM credentials — offer manual agent entry
    const manualAgents = await promptManualAgents(prompter);
    if (manualAgents.length > 0) {
      selectedAgents = manualAgents;
      await prompter.note(
        `Configured ${manualAgents.length} agent${manualAgents.length === 1 ? "" : "s"} (manual).`,
        "AI Fabric — Agents",
      );
    }
  }

  // --- Apply Config ---
  config = applyAiFabricConfig(config, {
    projectId: trimmedProjectId,
    keyId: auth?.keyId,
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
    const servers = result.data.filter((s) => s.status === "RUNNING" || s.status === "AVAILABLE");
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
    agents = result.data
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
// Manual Entry Helpers
// ---------------------------------------------------------------------------

function validateUrl(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return "URL is required";
  }
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "URL must start with http:// or https://";
    }
  } catch {
    return "Invalid URL format";
  }
  return undefined;
}

export async function promptManualMcpServers(
  prompter: WizardPrompter,
): Promise<Array<{ name: string; url: string }>> {
  const wantsManual = await prompter.confirm({
    message: "Enter MCP server URLs manually?",
    initialValue: false,
  });
  if (!wantsManual) {
    return [];
  }

  const entries: Array<{ name: string; url: string }> = [];
  let addMore = true;

  while (addMore) {
    const name = await prompter.text({
      message: "MCP server name",
      placeholder: "web-search",
      validate: (v) => (v.trim() ? undefined : "Name is required"),
    });

    const url = await prompter.text({
      message: "MCP server URL",
      placeholder: "https://ai-agents.api.cloud.ru/mcp/mcp-xxx",
      validate: validateUrl,
    });

    entries.push({ name: name.trim(), url: url.trim() });

    addMore = await prompter.confirm({
      message: "Add another MCP server?",
      initialValue: false,
    });
  }

  return entries;
}

export async function promptManualAgents(prompter: WizardPrompter): Promise<AiFabricAgentEntry[]> {
  const wantsManual = await prompter.confirm({
    message: "Enter AI Agent endpoints manually?",
    initialValue: false,
  });
  if (!wantsManual) {
    return [];
  }

  const agents: AiFabricAgentEntry[] = [];
  let addMore = true;

  while (addMore) {
    const name = await prompter.text({
      message: "Agent name",
      placeholder: "code-assistant",
      validate: (v) => (v.trim() ? undefined : "Name is required"),
    });

    const endpoint = await prompter.text({
      message: "Agent A2A endpoint URL",
      placeholder: "https://ai-agents.api.cloud.ru/a2a/agent-xxx",
      validate: validateUrl,
    });

    const trimmedName = name.trim();
    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    agents.push({
      id: `manual-${slug}`,
      name: trimmedName,
      endpoint: endpoint.trim(),
    });

    addMore = await prompter.confirm({
      message: "Add another agent?",
      initialValue: false,
    });
  }

  return agents;
}

// ---------------------------------------------------------------------------
// API Discovery Helpers
// ---------------------------------------------------------------------------

async function discoverMcpServers(params: {
  client: CloudruSimpleClient;
  prompter: WizardPrompter;
}): Promise<McpServer[] | null> {
  const spinner = params.prompter.progress("Discovering MCP servers...");
  try {
    const result = await params.client.listMcpServers();
    spinner.stop(`Found ${result.data.length} MCP server${result.data.length === 1 ? "" : "s"}`);
    return result.data;
  } catch (err) {
    const detail =
      err instanceof CloudruAuthError
        ? `IAM auth failed: ${err.message}`
        : err instanceof CloudruApiError
          ? `API error ${err.status}: ${err.message}`
          : describeNetworkError(err);
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
    const agents = result.data
      .filter((a): a is Agent & { endpoint: string } => a.endpoint != null)
      .map((a) => ({ id: a.id, name: a.name, endpoint: a.endpoint }));
    spinner.stop(
      agents.length > 0
        ? `Found ${agents.length} agent${agents.length === 1 ? "" : "s"}`
        : "No agents found",
    );
    return agents;
  } catch (err) {
    const detail =
      err instanceof CloudruAuthError
        ? `IAM auth failed: ${err.message}`
        : err instanceof CloudruApiError
          ? `API error ${err.status}: ${err.message}`
          : describeNetworkError(err);
    spinner.stop(`Agent discovery failed: ${detail}`);
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
