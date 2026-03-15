import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { parseModelRef } from "../agents/model-selection.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

export type AgentUiCommandOpts = {
  command?: string;
  arg?: string[];
  provider?: string;
  model?: string;
  cwd?: string;
  agent?: string;
  noBridgeMemory?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

type LaunchSpec = {
  command: string;
  args: string[];
  provider?: string;
};

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const BRIDGE_START = "<!-- OPENCLAW_MEMORY_BRIDGE:START -->";
const BRIDGE_END = "<!-- OPENCLAW_MEMORY_BRIDGE:END -->";

const DEFAULT_MEMORY_TEMPLATE = `# MEMORY.md\n\nLong-term memory for this OpenClaw agent workspace.\n`;

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveProviderFromOpts(params: {
  provider?: string;
  model?: string;
}): string | undefined {
  const explicit = trimOrUndefined(params.provider);
  if (explicit) {
    return explicit;
  }
  const model = trimOrUndefined(params.model);
  if (!model) {
    return undefined;
  }
  const parsed = parseModelRef(model, "");
  const parsedProvider = parsed?.provider?.trim();
  return parsedProvider || undefined;
}

export function resolveAgentUiLaunchSpec(params: {
  command?: string;
  args?: string[];
  provider?: string;
  config: ReturnType<typeof loadConfig>;
}): LaunchSpec {
  const commandOverride = trimOrUndefined(params.command);
  const args = Array.isArray(params.args) ? params.args.map(String) : [];
  if (commandOverride) {
    return {
      command: commandOverride,
      args,
      provider: trimOrUndefined(params.provider),
    };
  }

  const provider = trimOrUndefined(params.provider);
  if (!provider) {
    throw new Error("Provide --command <binary> or --provider <id> (or --model provider/model).");
  }

  const backend = resolveCliBackendConfig(provider, params.config);
  if (!backend?.config.command?.trim()) {
    throw new Error(
      `No CLI backend configured for provider "${provider}". Set agents.defaults.cliBackends.${provider}.command or pass --command.`,
    );
  }

  return {
    command: backend.config.command.trim(),
    args,
    provider: backend.id,
  };
}

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }
}

function buildBridgeBlock(params: {
  workspaceAgentsPath: string;
  memoryDir: string;
  memoryFile: string;
}): string {
  return [
    BRIDGE_START,
    "## OpenClaw Memory Bridge",
    "",
    "Use the OpenClaw workspace memory files as canonical memory for this project:",
    `- OpenClaw AGENTS.md: ${params.workspaceAgentsPath}`,
    `- Daily memory dir: ${params.memoryDir}`,
    `- Long-term memory file: ${params.memoryFile}`,
    "",
    "If this project has extra rules, follow both sets of instructions.",
    BRIDGE_END,
    "",
  ].join("\n");
}

export function resolveAgentUiMemoryBridgePaths(params: {
  targetDir: string;
  workspaceDir: string;
}) {
  const targetDir = resolveUserPath(params.targetDir);
  const workspaceDir = resolveUserPath(params.workspaceDir);

  const workspaceAgentsPath = path.join(workspaceDir, "AGENTS.md");
  const memoryDir = path.join(workspaceDir, "memory");
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const targetAgentsPath = path.join(targetDir, "AGENTS.md");

  return {
    targetAgentsPath,
    workspaceAgentsPath,
    memoryDir,
    memoryFile,
  };
}

export async function ensureAgentUiMemoryBridge(params: {
  targetDir: string;
  workspaceDir: string;
}) {
  const { targetAgentsPath, workspaceAgentsPath, memoryDir, memoryFile } =
    resolveAgentUiMemoryBridgePaths(params);

  await fs.mkdir(path.dirname(targetAgentsPath), { recursive: true });

  await fs.mkdir(memoryDir, { recursive: true });
  await writeFileIfMissing(memoryFile, DEFAULT_MEMORY_TEMPLATE);

  const bridgeBlock = buildBridgeBlock({
    workspaceAgentsPath,
    memoryDir,
    memoryFile,
  });

  let current = "";
  try {
    current = await fs.readFile(targetAgentsPath, "utf-8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  let next: string;
  if (!current.trim()) {
    next = bridgeBlock;
  } else if (current.includes(BRIDGE_START) && current.includes(BRIDGE_END)) {
    const pattern = new RegExp(`${BRIDGE_START}[\\s\\S]*?${BRIDGE_END}\\n?`, "m");
    next = current.replace(pattern, bridgeBlock);
  } else {
    const normalized = current.endsWith("\n") ? current : `${current}\n`;
    next = `${normalized}\n${bridgeBlock}`;
  }

  if (next !== current) {
    await fs.writeFile(targetAgentsPath, next, { encoding: "utf-8" });
  }

  return {
    targetAgentsPath,
    workspaceAgentsPath,
    memoryDir,
    memoryFile,
  };
}

async function spawnInteractiveProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: "inherit",
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

export async function agentUiCommand(opts: AgentUiCommandOpts, runtime: RuntimeEnv) {
  const cfg = loadConfig();

  const agentId = trimOrUndefined(opts.agent) ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!opts.dryRun) {
    await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });
  }

  const launchCwd = resolveUserPath(trimOrUndefined(opts.cwd) ?? process.cwd());

  const provider = resolveProviderFromOpts({
    provider: opts.provider,
    model: opts.model,
  });

  const launchSpec = resolveAgentUiLaunchSpec({
    command: opts.command,
    args: opts.arg,
    provider,
    config: cfg,
  });

  const bridgeEnabled = opts.noBridgeMemory !== true;
  const bridge = bridgeEnabled
    ? opts.dryRun
      ? resolveAgentUiMemoryBridgePaths({ targetDir: launchCwd, workspaceDir })
      : await ensureAgentUiMemoryBridge({ targetDir: launchCwd, workspaceDir })
    : null;

  const payload = {
    mode: "external-ui",
    agentId,
    cwd: launchCwd,
    workspaceDir,
    provider: launchSpec.provider,
    command: launchSpec.command,
    args: launchSpec.args,
    bridge,
  };

  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
  } else {
    runtime.log(
      `Launching external agent UI: ${launchSpec.command} ${launchSpec.args.join(" ")}`.trim(),
    );
    runtime.log(`cwd: ${launchCwd}`);
    if (bridge) {
      runtime.log(`AGENTS bridge: ${bridge.targetAgentsPath}`);
    }
  }

  if (opts.dryRun) {
    return payload;
  }

  const env = {
    ...process.env,
    OPENCLAW_EXTERNAL_UI: "1",
    OPENCLAW_AGENT_ID: agentId,
    OPENCLAW_AGENT_WORKSPACE: workspaceDir,
    OPENCLAW_AGENT_MEMORY_DIR: path.join(workspaceDir, "memory"),
    OPENCLAW_AGENT_MEMORY_FILE: path.join(workspaceDir, "MEMORY.md"),
  };

  const result = await spawnInteractiveProcess({
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: launchCwd,
    env,
  });

  if (result.signal) {
    throw new Error(`External agent UI terminated by signal ${result.signal}.`);
  }
  if ((result.code ?? 1) !== 0) {
    throw new Error(`External agent UI exited with code ${String(result.code)}.`);
  }

  return payload;
}
