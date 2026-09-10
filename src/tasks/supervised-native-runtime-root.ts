import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { SupervisedTask } from "./supervised-task.types.js";

// Select the native store without relocating auth or creating a new directory.
// Callers retain existence checks and the payload recipe's host-owner/path fence.
function resolveSupervisedNativeRuntimeRoot(runtime: SupervisedTask["runtime"]): string {
  return runtime === "claude-cli"
    ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"))
    : process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/** Canonicalize host-selected roots before private tmp overlays hide their
 * lexical aliases. Never bind a second writable alias of the artifact store. */
export async function prepareSupervisedRuntimePaths(params: {
  databasePath: string;
  agentId: string;
  runtime: SupervisedTask["runtime"];
  assertCurrent: () => void;
}) {
  const config = getRuntimeConfig();
  const agentDir = resolveAgentDir(config, params.agentId);
  const roots = new Set<string>();
  for (const root of [path.dirname(params.databasePath), path.dirname(agentDir)]) {
    params.assertCurrent();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    roots.add(await fs.realpath(root));
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const nativeRoot = resolveSupervisedNativeRuntimeRoot(params.runtime);
  if (nativeRoot) {
    try {
      const canonical = await fs.realpath(nativeRoot);
      roots.add(canonical);
      env[params.runtime === "claude-cli" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = canonical;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const readOnlyRuntimeFiles: string[] = [];
  try {
    const configFile = await fs.realpath(resolveConfigPath());
    readOnlyRuntimeFiles.push(configFile);
    env.OPENCLAW_CONFIG_PATH = configFile;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  env.OPENCLAW_STATE_DIR = await fs.realpath(resolveStateDir());
  params.assertCurrent();
  return {
    writableRuntimePaths: [...roots],
    readOnlyRuntimeFiles,
    databasePath: path.join(
      await fs.realpath(path.dirname(params.databasePath)),
      path.basename(params.databasePath),
    ),
    agentDir: path.join(await fs.realpath(path.dirname(agentDir)), path.basename(agentDir)),
    env,
  };
}

/** Payload-only projection of the same host-selected agent directory. This
 * changes no authored config or auth store and never runs in the Gateway. */
export function bindSupervisedPayloadAgentDirectory(agentId: string, agentDir: string) {
  if (!path.isAbsolute(agentDir) || path.resolve(agentDir) !== agentDir) {
    throw new Error("Invalid supervised payload agent directory");
  }
  const config = getRuntimeConfig();
  setRuntimeConfigSnapshot(
    {
      ...config,
      agents: {
        ...config.agents,
        entries: {
          ...config.agents?.entries,
          [agentId]: { ...config.agents?.entries?.[agentId], agentDir },
        },
      },
    },
    config,
  );
}
