import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { ActiviConfig } from "../config/config.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardStep } from "./session.js";

export type WebOnboardingState = {
  step: number;
  apiKey?: string;
  apiProvider?: string;
  workspacePath?: string;
  gatewayPort?: number;
  gatewayBind?: "loopback" | "lan" | "tailnet";
  gatewayAuthMode?: "token" | "password";
  gatewayAuthToken?: string;
  gatewayAuthPassword?: string;
  gatewayRemoteAccess?: boolean;
  channels?: Array<{ id: string; connected: boolean }>;
  agentMode?: "single" | "team";
  agentName?: string;
  agentCount?: number;
  agentsCreated?: Array<{ id: string; name: string; workspace: string }>;
  masterAdmin?: boolean;
};

export async function runWebOnboardingWizard(
  prompter: WizardPrompter,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<{ config: ActiviConfig; state: WebOnboardingState }> {
  const state: WebOnboardingState = { step: 1 };

  // Step 1: Welcome
  await prompter.intro("Willkommen bei Activi");

  // Step 2: AI Model / API Key
  const provider = await prompter.select({
    message: "AI Provider auswählen",
    options: [
      { value: "anthropic", label: "Anthropic (empfohlen)", hint: "Claude Models" },
      { value: "openai", label: "OpenAI", hint: "GPT Models" },
      { value: "custom", label: "Custom Provider", hint: "Eigener Provider" },
    ],
    initialValue: "anthropic",
  });
  state.apiProvider = provider as string;

  const apiKey = await prompter.text({
    message: "API Key eingeben",
    placeholder: "sk-...",
    sensitive: true,
    validate: (value) => {
      if (!value.trim()) {
        return "API Key ist erforderlich";
      }
      // Basic format validation (can be enhanced with actual API test)
      if (provider === "anthropic" && !value.startsWith("sk-ant-")) {
        return "Ungültiges Format für Anthropic API Key";
      }
      if (provider === "openai" && !value.startsWith("sk-")) {
        return "Ungültiges Format für OpenAI API Key";
      }
      return undefined;
    },
  });
  state.apiKey = apiKey;

  // Step 3: Workspace
  const workspacePath = await prompter.text({
    message: "Workspace-Verzeichnis",
    initialValue: "~/.activi/workspace",
    placeholder: "~/.activi/workspace",
  });
  state.workspacePath = workspacePath;

  // Step 4: Gateway Configuration
  const gatewayPort = await prompter.text({
    message: "Gateway Port",
    initialValue: String(DEFAULT_GATEWAY_PORT),
    placeholder: String(DEFAULT_GATEWAY_PORT),
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return "Port muss zwischen 1024 und 65535 sein";
      }
      return undefined;
    },
  });
  state.gatewayPort = parseInt(gatewayPort, 10);

  const gatewayBind = await prompter.select({
    message: "Gateway Bind-Modus",
    options: [
      { value: "loopback", label: "Loopback (nur lokal)", hint: "Sicherer Default" },
      { value: "lan", label: "LAN", hint: "Lokales Netzwerk" },
      { value: "tailscale", label: "Tailscale", hint: "Tailnet-Zugriff" },
    ],
    initialValue: "loopback",
  });
  state.gatewayBind = gatewayBind as "loopback" | "lan" | "tailnet";

  const gatewayAuthMode = await prompter.select({
    message: "Gateway Authentifizierung",
    options: [
      { value: "token", label: "Token (auto-generiert)", hint: "Empfohlen" },
      { value: "password", label: "Passwort", hint: "Manuell eingeben" },
    ],
    initialValue: "token",
  });
  state.gatewayAuthMode = gatewayAuthMode as "token" | "password";

  if (gatewayAuthMode === "token") {
    state.gatewayAuthToken = crypto.randomBytes(32).toString("hex");
  } else {
    const password = await prompter.text({
      message: "Gateway Passwort",
      sensitive: true,
      validate: (value) => {
        if (!value.trim() || value.length < 8) {
          return "Passwort muss mindestens 8 Zeichen lang sein";
        }
        return undefined;
      },
    });
    state.gatewayAuthPassword = password;
  }

  const remoteAccess = await prompter.confirm({
    message: "Remote-Zugriff erlauben?",
    initialValue: false,
  });
  state.gatewayRemoteAccess = remoteAccess;

  // Step 5: Channels (optional, can skip)
  const setupChannels = await prompter.confirm({
    message: "Channels jetzt einrichten?",
    initialValue: false,
  });
  state.channels = [];

  // Step 6: Team / Agents
  const agentMode = await prompter.select({
    message: "Agent-Modus",
    options: [
      { value: "single", label: "Einzel-Agent", hint: "Ein Agent wird erstellt" },
      {
        value: "team",
        label: "Team-Modus",
        hint: "Mehrere Agents + Master-Admin",
      },
    ],
    initialValue: "single",
  });
  state.agentMode = agentMode as "single" | "team";

  const workspaceDir = resolveUserPath(state.workspacePath || "~/.activi/workspace");
  const snapshot = await readConfigFileSnapshot();
  let config: ActiviConfig = snapshot.valid ? snapshot.config : {};

  if (agentMode === "single") {
    const agentName = await prompter.text({
      message: "Agent-Name",
      initialValue: "main",
      placeholder: "main",
      validate: (value) => {
        if (!value.trim()) {
          return "Agent-Name ist erforderlich";
        }
        const normalized = normalizeAgentId(value);
        if (normalized === DEFAULT_AGENT_ID) {
          return `"${DEFAULT_AGENT_ID}" ist reserviert`;
        }
        return undefined;
      },
    });
    state.agentName = agentName;

    // Create single agent
    const agentId = normalizeAgentId(agentName);
    const agentWorkspace = path.join(workspaceDir, agentId);
    await ensureAgentWorkspace({ dir: agentWorkspace, ensureBootstrapFiles: true });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    config.agents = config.agents || {};
    config.agents.list = config.agents.list || [];
    config.agents.list.push({
      id: agentId,
      name: agentName,
      workspace: agentWorkspace,
    });

    state.agentsCreated = [{ id: agentId, name: agentName, workspace: agentWorkspace }];
  } else {
    // Team mode
    state.masterAdmin = true;

    const agentCount = await prompter.text({
      message: "Wie viele Agents?",
      initialValue: "3",
      placeholder: "3",
      validate: (value) => {
        const count = parseInt(value, 10);
        if (isNaN(count) || count < 2 || count > 20) {
          return "Anzahl muss zwischen 2 und 20 sein";
        }
        return undefined;
      },
    });
    state.agentCount = parseInt(agentCount, 10);

    // Create agents in parallel
    const agentPromises = Array.from({ length: state.agentCount }, async (_, i) => {
      const agentId = `agent-${i + 1}`;
      const agentWorkspace = path.join(workspaceDir, agentId);
      await ensureAgentWorkspace({ dir: agentWorkspace, ensureBootstrapFiles: true });
      await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

      return {
        id: agentId,
        name: `Agent ${i + 1}`,
        workspace: agentWorkspace,
      };
    });

    const agents = await Promise.all(agentPromises);
    state.agentsCreated = agents;

    config.agents = config.agents || {};
    config.agents.list = config.agents.list || [];
    config.agents.list.push(...agents.map((a) => ({ id: a.id, name: a.name, workspace: a.workspace })));
  }

  // Apply gateway config
  config.gateway = config.gateway || {};
  config.gateway.port = state.gatewayPort;
  config.gateway.bind = state.gatewayBind;
  config.gateway.auth = config.gateway.auth || {};
  config.gateway.auth.mode = state.gatewayAuthMode;
  if (state.gatewayAuthToken) {
    config.gateway.auth.token = state.gatewayAuthToken;
  }
  if (state.gatewayAuthPassword) {
    config.gateway.auth.password = state.gatewayAuthPassword;
  }

  // Apply workspace config
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  if (!config.agents.defaults.workspace) {
    config.agents.defaults.workspace = workspaceDir;
  }

  // Apply API key config (simplified - would need proper auth profile setup)
  // This is a placeholder - actual implementation would use applyAuthChoice

  await writeConfigFile(config);

  return { config, state };
}
