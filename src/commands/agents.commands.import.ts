import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { extractArchive, fileExists, readJsonFile, resolveArchiveKind } from "../infra/archive.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { createQuietRuntime, requireValidConfigFileSnapshot } from "./agents.command-shared.js";
import { applyAgentConfig, findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";

type AgentsImportOptions = {
  file: string;
  force?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
};

type ImportedAgentConfig = {
  id: string;
  name?: string;
  workspace?: string;
  model?: string;
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-import-"));
  try {
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function agentsImportCommand(
  opts: AgentsImportOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  const filePath = opts.file?.trim();
  if (!filePath) {
    runtime.error("Import file path is required.");
    runtime.exit(1);
    return;
  }

  // 1. Validate file exists
  const exists = await fileExists(filePath);
  if (!exists) {
    runtime.error(`Import file not found: ${filePath}`);
    runtime.exit(1);
    return;
  }

  // 2. Validate archive format
  const archiveKind = resolveArchiveKind(filePath);
  if (!archiveKind) {
    runtime.error("Unsupported archive format. Expected .tar.gz, .tgz, .tar, or .zip file.");
    runtime.exit(1);
    return;
  }

  // 3. Extract to temp dir and read agent.json
  const agentConfig = await withTempDir(async (tmpDir) => {
    await extractArchive({
      archivePath: filePath,
      destDir: tmpDir,
      timeoutMs: 60_000,
    });

    const agentJsonPath = path.join(tmpDir, "agent.json");
    const agentJsonExists = await fileExists(agentJsonPath);
    if (!agentJsonExists) {
      runtime.error("Archive missing required file: agent.json");
      runtime.exit(1);
      return null;
    }

    let parsed: ImportedAgentConfig;
    try {
      parsed = await readJsonFile<ImportedAgentConfig>(agentJsonPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      runtime.error(`Failed to parse agent.json: ${detail}`);
      runtime.exit(1);
      return null;
    }

    if (!parsed.id || typeof parsed.id !== "string") {
      runtime.error("agent.json missing required field: id");
      runtime.exit(1);
      return null;
    }

    return parsed;
  });

  if (!agentConfig) {
    return;
  }

  const agentId = normalizeAgentId(agentConfig.id);
  if (agentId !== agentConfig.id) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }

  // 4. Check for reserved agent id
  if (agentId === DEFAULT_AGENT_ID) {
    runtime.error(`Agent id "${DEFAULT_AGENT_ID}" is reserved.`);
    runtime.exit(1);
    return;
  }

  // 5. Check if agent already exists
  const existingIndex = findAgentEntryIndex(listAgentEntries(cfg), agentId);
  const agentExists = existingIndex >= 0;

  if (agentExists && !opts.force) {
    if (!opts.nonInteractive && process.stdin.isTTY) {
      const prompter = createClackPrompter();
      const confirmed = await prompter.confirm({
        message: `Agent "${agentId}" already exists. Overwrite it?`,
        initialValue: false,
      });
      if (!confirmed) {
        runtime.log("Cancelled.");
        return;
      }
    } else if (opts.nonInteractive || !process.stdin.isTTY) {
      runtime.error(`Agent "${agentId}" already exists. Use --force to overwrite.`);
      runtime.exit(1);
      return;
    }
  }

  // 6. Determine target paths
  const targetAgentDir = resolveAgentDir(cfg, agentId);
  const targetWorkspace = agentConfig.workspace
    ? resolveUserPath(agentConfig.workspace)
    : resolveAgentWorkspaceDir(cfg, agentId);

  // 7. Extract workspace files
  await withTempDir(async (tmpDir) => {
    await extractArchive({
      archivePath: filePath,
      destDir: tmpDir,
      timeoutMs: 60_000,
    });

    const sourceWorkspace = path.join(tmpDir, "workspace");
    const workspaceExists = await fileExists(sourceWorkspace);

    if (workspaceExists) {
      await fs.cp(sourceWorkspace, targetWorkspace, { recursive: true });
    }
  });

  // 8. Apply config
  const nextConfig = applyAgentConfig(cfg, {
    agentId,
    name: agentConfig.name,
    workspace: targetWorkspace,
    agentDir: targetAgentDir,
    model: agentConfig.model,
  });

  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });

  if (!opts.json) {
    logConfigUpdated(runtime);
  }

  // 9. Ensure workspace and sessions
  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  await ensureWorkspaceAndSessions(targetWorkspace, quietRuntime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    agentId,
  });

  // 10. Output result
  const payload = {
    agentId,
    name: agentConfig.name,
    workspace: targetWorkspace,
    agentDir: targetAgentDir,
    model: agentConfig.model,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
  } else {
    runtime.log(`Imported agent: ${agentId}`);
    runtime.log(`Workspace: ${shortenHomePath(targetWorkspace)}`);
    runtime.log(`Agent dir: ${shortenHomePath(targetAgentDir)}`);
    if (agentConfig.model) {
      runtime.log(`Model: ${agentConfig.model}`);
    }
  }
}
