import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
} from "../agents/workspace.js";
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
  agentMode?: "single" | "team" | "swarm";
  agentName?: string;
  agentCount?: number;
  swarmCount?: number;
  swarmStrategy?: "parallel" | "sequential";
  agentsCreated?: Array<{ id: string; name: string; workspace: string }>;
  masterAdmin?: boolean;
  agentRules?: string;
  agentCommands?: string;
  agentSystemPrompt?: string;
  skillsMode?: "allowlist" | "blocklist" | "all";
  skillsAllowlist?: string[];
  skillsBlocklist?: string[];
};

export async function createWebOnboardingWizardSteps(
  prompter: WizardPrompter,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<WizardStep[]> {
  const steps: WizardStep[] = [];

  // Step 0: Security Warning (optional, can be skipped with acceptRisk flag)
  // Note: Security warning is shown before welcome step in CLI wizard
  // For web wizard, we could add it as a separate step or show it as a modal

  // Step 1: Welcome
  steps.push({
    id: randomUUID(),
    type: "welcome",
    title: "Willkommen bei Activi",
    message: "Dein AI-Agent Command Center",
    logo: "/logo-activi-animated.mp4",
    executor: "client",
  });

  // Step 2: AI Model / API Key
  steps.push({
    id: randomUUID(),
    type: "api-key",
    title: "AI Model / API Key",
    message: "Wähle deinen AI-Provider und gib deinen API-Key ein",
    options: [
      { value: "anthropic", label: "Anthropic (empfohlen)", hint: "Claude Models" },
      { value: "openai", label: "OpenAI", hint: "GPT Models" },
      { value: "custom", label: "Custom Provider", hint: "Eigener Provider" },
    ],
    initialValue: "anthropic",
    placeholder: "sk-...",
    sensitive: true,
    validation: {
      required: true,
    },
    executor: "client",
  });

  // Step 3: Workspace
  steps.push({
    id: randomUUID(),
    type: "workspace-path",
    title: "Workspace",
    message: "Wo soll Activi Sessions, Configs und Agent-Daten speichern?",
    initialValue: "~/.activi/workspace",
    placeholder: "~/.activi/workspace",
    executor: "client",
  });

  // Step 4: Gateway Configuration
  steps.push({
    id: randomUUID(),
    type: "gateway-config",
    title: "Gateway Konfiguration",
    message: "Konfiguriere dein Gateway",
    options: [
      { value: "loopback", label: "Loopback (nur lokal)", hint: "Sicherer Default" },
      { value: "lan", label: "LAN", hint: "Lokales Netzwerk" },
      { value: "tailscale", label: "Tailscale", hint: "Tailnet-Zugriff" },
    ],
    initialValue: "loopback",
    executor: "client",
  });

  // Step 5: Channels (optional)
  steps.push({
    id: randomUUID(),
    type: "channel-cards",
    title: "Channels verbinden",
    message: "Verbinde deine Messaging-Channels (optional)",
    items: [
      { id: "whatsapp", label: "WhatsApp", icon: "messageSquare" },
      { id: "telegram", label: "Telegram", icon: "messageSquare" },
      { id: "discord", label: "Discord", icon: "messageSquare" },
      { id: "slack", label: "Slack", icon: "messageSquare" },
    ],
    executor: "client",
  });

  // Step 6: Agent Mode Selection
  steps.push({
    id: randomUUID(),
    type: "agent-mode-select",
    title: "Team / Agents",
    message: "Wie möchtest du Agents einrichten?",
    options: [
      { value: "single", label: "Einzel-Agent", hint: "Ein Agent wird erstellt" },
      {
        value: "team",
        label: "Team-Modus",
        hint: "Mehrere Agents + Master-Admin",
      },
      {
        value: "swarm",
        label: "Schwarm-Modus",
        hint: "Viele Agents arbeiten parallel zusammen",
      },
    ],
    initialValue: "single",
    executor: "client",
  });

  // Step 7: Skills Configuration (Allow/Block Lists)
  steps.push({
    id: randomUUID(),
    type: "skills-config",
    title: "Skills-Verwaltung",
    message: "Welche Skills sollen erlaubt oder blockiert sein?",
    executor: "client",
  });

  return steps;
}

export async function processWebOnboardingStep(
  step: WizardStep,
  answer: unknown,
  state: WebOnboardingState,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<{ nextStep?: WizardStep; config?: ActiviConfig; done: boolean }> {
  const snapshot = await readConfigFileSnapshot();
  let config: ActiviConfig = snapshot.valid ? snapshot.config : {};

  switch (step.type) {
    case "welcome":
      // No action needed, just proceed
      return { done: false };

    case "api-key": {
      const provider = (answer as { provider?: string; apiKey?: string })?.provider || "anthropic";
      const apiKey = (answer as { provider?: string; apiKey?: string })?.apiKey || "";
      state.apiProvider = provider;
      state.apiKey = apiKey;
      return { done: false };
    }

    case "workspace-path": {
      const workspacePath = (answer as string) || "~/.activi/workspace";
      state.workspacePath = workspacePath;
      return { done: false };
    }

    case "gateway-config": {
      const gatewayConfig = answer as {
        port?: number;
        bind?: "loopback" | "lan" | "tailnet";
        authMode?: "token" | "password";
        password?: string;
        remoteAccess?: boolean;
      };
      state.gatewayPort = gatewayConfig.port || DEFAULT_GATEWAY_PORT;
      state.gatewayBind = gatewayConfig.bind || "loopback";
      state.gatewayAuthMode = gatewayConfig.authMode || "token";
      if (state.gatewayAuthMode === "token") {
        state.gatewayAuthToken = crypto.randomBytes(32).toString("hex");
      } else {
        state.gatewayAuthPassword = gatewayConfig.password || "";
      }
      state.gatewayRemoteAccess = gatewayConfig.remoteAccess || false;
      return { done: false };
    }

    case "channel-cards": {
      // Channels are optional, can skip
      const channels = (answer as Array<{ id: string; connected: boolean }>) || [];
      state.channels = channels;
      return { done: false };
    }

    case "agent-mode-select": {
      const agentMode = (answer as "single" | "team" | "swarm") || "single";
      state.agentMode = agentMode;

      if (agentMode === "single") {
        // Return single agent form step
        return {
          done: false,
          nextStep: {
            id: randomUUID(),
            type: "agent-single-form",
            title: "Einzel-Agent konfigurieren",
            message: "Gib Details für deinen Agent ein",
            placeholder: "main",
            initialValue: "main",
            executor: "client",
          },
        };
      } else if (agentMode === "team") {
        // Return team count step
        state.masterAdmin = true;
        return {
          done: false,
          nextStep: {
            id: randomUUID(),
            type: "agent-team-count",
            title: "Team-Modus",
            message: "Wie viele Agents möchtest du erstellen?",
            placeholder: "3",
            initialValue: "3",
            validation: {
              min: 2,
              max: 20,
              required: true,
            },
            executor: "client",
          },
        };
      } else {
        // Swarm mode
        state.masterAdmin = true;
        return {
          done: false,
          nextStep: {
            id: randomUUID(),
            type: "agent-swarm-config",
            title: "Schwarm-Modus",
            message: "Konfiguriere deinen Agenten-Schwarm",
            executor: "client",
          },
        };
      }
    }

    case "agent-single-form": {
      const agentData = answer as { name?: string; workspace?: string; model?: string };
      const agentName = agentData?.name || "main";
      state.agentName = agentName;

      const workspaceDir = resolveUserPath(state.workspacePath || "~/.activi/workspace");
      const agentId = normalizeAgentId(agentName);
      if (agentId === DEFAULT_AGENT_ID) {
        throw new Error(`"${DEFAULT_AGENT_ID}" ist reserviert`);
      }

      const agentWorkspace = path.join(workspaceDir, agentId);
        await ensureAgentWorkspace({
          dir: agentWorkspace,
          ensureBootstrapFiles: true,
        });
      await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

      // Write IDENTITY.md
      const identityPath = path.join(agentWorkspace, DEFAULT_IDENTITY_FILENAME);
      const safeName = agentName.replace(/[^\w\s-]/g, "").trim();
      await fs.appendFile(identityPath, `\n- Name: ${safeName}\n`, "utf-8");

      config.agents = config.agents || {};
      config.agents.list = config.agents.list || [];
      config.agents.list.push({
        id: agentId,
        name: agentName,
        workspace: agentWorkspace,
      });

      state.agentsCreated = [{ id: agentId, name: agentName, workspace: agentWorkspace }];

      // Apply gateway and workspace config
      await applyConfigFromState(config, state, workspaceDir);

      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "summary",
          title: "Fertig",
          message: "Activi ist bereit.",
          summary: buildSummary(state),
          executor: "client",
        },
        config,
      };
    }

    case "agent-team-count": {
      const count = parseInt((answer as string) || "3", 10);
      state.agentCount = count;

      const workspaceDir = resolveUserPath(state.workspacePath || "~/.activi/workspace");

      // Create agents in parallel
      const agentPromises = Array.from({ length: count }, async (_, i) => {
        const agentId = `agent-${i + 1}`;
        const agentName = `Agent ${i + 1}`;
        const agentWorkspace = path.join(workspaceDir, agentId);
        await ensureAgentWorkspace({
          dir: agentWorkspace,
          ensureBootstrapFiles: true,
        });
        await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

        // Write IDENTITY.md
        const identityPath = path.join(agentWorkspace, DEFAULT_IDENTITY_FILENAME);
        const safeName = agentName.replace(/[^\w\s-]/g, "").trim();
        await fs.appendFile(identityPath, `\n- Name: ${safeName}\n`, "utf-8");

        return {
          id: agentId,
          name: agentName,
          workspace: agentWorkspace,
        };
      });

      const agents = await Promise.all(agentPromises);
      state.agentsCreated = agents;

      config.agents = config.agents || {};
      config.agents.list = config.agents.list || [];
      config.agents.list.push(...agents.map((a) => ({ id: a.id, name: a.name, workspace: a.workspace })));

      // Apply gateway and workspace config
      await applyConfigFromState(config, state, workspaceDir);

      // Return agent grid overview
      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "agent-grid",
          title: "Agents erstellt",
          message: `${agents.length} Agents wurden erfolgreich erstellt`,
          items: agents.map((a) => ({ id: a.id, label: a.name })),
          executor: "client",
        },
        config,
      };
    }

    case "agent-swarm-config": {
      const swarmConfig = answer as {
        count?: number;
        strategy?: "parallel" | "sequential";
      };
      const count = swarmConfig.count ? parseInt(String(swarmConfig.count), 10) : 10;
      const strategy = swarmConfig.strategy || "parallel";

      if (isNaN(count) || count < 5 || count > 100) {
        return { done: false };
      }

      state.swarmCount = count;
      state.swarmStrategy = strategy;

      const workspaceDir = resolveUserPath(state.workspacePath || "~/.activi/workspace");

      // Create swarm agents in parallel
      const agentPromises = Array.from({ length: count }, async (_, i) => {
        const agentId = `swarm-${i + 1}`;
        const agentName = `Swarm Agent ${i + 1}`;
        const agentWorkspace = path.join(workspaceDir, agentId);
        await ensureAgentWorkspace({
          dir: agentWorkspace,
          ensureBootstrapFiles: true,
        });
        await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

        // Write IDENTITY.md
        const identityPath = path.join(agentWorkspace, DEFAULT_IDENTITY_FILENAME);
        const safeName = agentName.replace(/[^\w\s-]/g, "").trim();
        await fs.appendFile(identityPath, `\n- Name: ${safeName}\n`, "utf-8");

        return {
          id: agentId,
          name: agentName,
          workspace: agentWorkspace,
        };
      });

      const agents = await Promise.all(agentPromises);
      state.agentsCreated = agents;

      config.agents = config.agents || {};
      config.agents.list = config.agents.list || [];
      config.agents.list.push(...agents.map((a) => ({ id: a.id, name: a.name, workspace: a.workspace })));

      // Configure broadcast groups for swarm (all agents work together)
      config.broadcast = config.broadcast || {};
      config.broadcast.strategy = strategy;
      // Note: Broadcast groups are configured per-channel, so we'll set a default
      // Users can configure specific channels later

      // Apply gateway and workspace config
      await applyConfigFromState(config, state, workspaceDir);

      // Show agent grid
      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "agent-grid",
          title: "Schwarm erstellt",
          message: `${agents.length} Schwarm-Agents wurden erfolgreich erstellt`,
          items: agents.map((a) => ({ id: a.id, label: a.name })),
          executor: "client",
        },
        config,
      };
    }

    case "agent-grid": {
      // Show advanced agent config step after agent grid
      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "agent-config-advanced",
          title: "Agent-Konfiguration (Optional)",
          message: "Konfiguriere Rules, Commands und System-Prompt für deine Agents",
          executor: "client",
        },
        config,
      };
    }

    case "agent-config-advanced": {
      const advancedConfig = answer as {
        rules?: string;
        commands?: string;
        systemPrompt?: string;
      };
      state.agentRules = advancedConfig.rules;
      state.agentCommands = advancedConfig.commands;
      state.agentSystemPrompt = advancedConfig.systemPrompt;

      // Apply advanced config to all created agents
      if (state.agentsCreated && (state.agentRules || state.agentCommands || state.agentSystemPrompt)) {
        const workspaceDir = resolveUserPath(state.workspacePath || "~/.activi/workspace");

        for (const agent of state.agentsCreated) {
          const agentWorkspace = agent.workspace;

          // Write AGENTS.md (rules)
          if (state.agentRules) {
            const agentsPath = path.join(agentWorkspace, DEFAULT_AGENTS_FILENAME);
            await fs.writeFile(agentsPath, state.agentRules, "utf-8");
          }

          // Write TOOLS.md (commands)
          if (state.agentCommands) {
            const toolsPath = path.join(agentWorkspace, DEFAULT_TOOLS_FILENAME);
            await fs.writeFile(toolsPath, state.agentCommands, "utf-8");
          }

          // Write SOUL.md (system prompt)
          if (state.agentSystemPrompt) {
            const soulPath = path.join(agentWorkspace, DEFAULT_SOUL_FILENAME);
            await fs.writeFile(soulPath, state.agentSystemPrompt, "utf-8");
          }
        }
      }

      // Show skills config step after advanced config
      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "skills-config",
          title: "Skills-Verwaltung",
          message: "Welche Skills sollen erlaubt oder blockiert sein?",
          executor: "client",
        },
        config,
      };
    }

    case "skills-config": {
      const skillsConfig = answer as {
        mode?: "allowlist" | "blocklist" | "all";
        allowlist?: string[];
        blocklist?: string[];
      };
      state.skillsMode = skillsConfig.mode || "all";
      state.skillsAllowlist = skillsConfig.allowlist || [];
      state.skillsBlocklist = skillsConfig.blocklist || [];

      // Apply skills config to agents
      if (config.agents?.list) {
        for (const agent of config.agents.list) {
          if (state.skillsMode === "allowlist" && state.skillsAllowlist.length > 0) {
            agent.skills = state.skillsAllowlist;
          } else if (state.skillsMode === "blocklist") {
            // Blocklist wird über tools.deny oder per-agent config gehandhabt
            // Für jetzt: leere allowlist = keine skills
            agent.skills = [];
          }
          // "all" = keine Einschränkung, skills bleibt undefined
        }
      }

      // Show summary after skills config
      return {
        done: false,
        nextStep: {
          id: randomUUID(),
          type: "summary",
          title: "Fertig",
          message: "Activi ist bereit.",
          summary: buildSummary(state),
          executor: "client",
        },
        config,
      };
    }

    case "summary": {
      // Wizard complete
      return { done: true, config };
    }

    default:
      return { done: false };
  }
}

async function applyConfigFromState(
  config: ActiviConfig,
  state: WebOnboardingState,
  workspaceDir: string,
): Promise<void> {
  // Apply gateway config
  config.gateway = config.gateway || {};
  if (state.gatewayPort) {
    config.gateway.port = state.gatewayPort;
  }
  if (state.gatewayBind) {
    config.gateway.bind = state.gatewayBind;
  }
  config.gateway.auth = config.gateway.auth || {};
  if (state.gatewayAuthMode) {
    config.gateway.auth.mode = state.gatewayAuthMode;
  }
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

  // TODO: Apply API key config (would need proper auth profile setup)

  await writeConfigFile(config);
}

function buildSummary(state: WebOnboardingState): Array<{ label: string; value: string }> {
  const summary: Array<{ label: string; value: string }> = [];

  if (state.apiProvider) {
    summary.push({ label: "AI Provider", value: state.apiProvider });
  }
  if (state.workspacePath) {
    summary.push({ label: "Workspace", value: state.workspacePath });
  }
  if (state.gatewayPort) {
    summary.push({ label: "Gateway Port", value: String(state.gatewayPort) });
  }
  if (state.gatewayBind) {
    summary.push({ label: "Gateway Bind", value: state.gatewayBind });
  }
  if (state.agentMode === "single" && state.agentName) {
    summary.push({ label: "Agent", value: state.agentName });
  } else if (state.agentMode === "team" && state.agentCount) {
    summary.push({ label: "Agents", value: `${state.agentCount} Agents erstellt` });
    if (state.masterAdmin) {
      summary.push({ label: "Master-Admin", value: "Aktiviert" });
    }
  } else if (state.agentMode === "swarm" && state.swarmCount) {
    summary.push({ label: "Schwarm", value: `${state.swarmCount} Agents erstellt` });
    if (state.swarmStrategy) {
      summary.push({ label: "Strategie", value: state.swarmStrategy === "parallel" ? "Parallel" : "Sequentiell" });
    }
    if (state.masterAdmin) {
      summary.push({ label: "Master-Admin", value: "Aktiviert" });
    }
  }
  if (state.agentRules || state.agentCommands || state.agentSystemPrompt) {
    const configs = [];
    if (state.agentRules) configs.push("Rules");
    if (state.agentCommands) configs.push("Commands");
    if (state.agentSystemPrompt) configs.push("System-Prompt");
    summary.push({ label: "Agent-Config", value: configs.join(", ") });
  }
  if (state.skillsMode) {
    if (state.skillsMode === "allowlist" && state.skillsAllowlist) {
      summary.push({ label: "Skills", value: `Allowlist: ${state.skillsAllowlist.length} Skills` });
    } else if (state.skillsMode === "blocklist" && state.skillsBlocklist) {
      summary.push({ label: "Skills", value: `Blocklist: ${state.skillsBlocklist.length} Skills` });
    } else if (state.skillsMode === "all") {
      summary.push({ label: "Skills", value: "Alle Skills erlaubt" });
    }
  }

  return summary;
}
