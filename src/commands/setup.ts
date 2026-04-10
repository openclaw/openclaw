import fs from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { type OpenClawConfig, createConfigIO, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";

const JsonRecordSchema = z.record(z.string(), z.unknown());

type SetupCommandDeps = {
  ensureAgentWorkspace?: typeof ensureAgentWorkspace;
  mkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>;
  resolveSessionTranscriptsDir?: () => string | Promise<string>;
  writeConfigFile?: typeof writeConfigFile;
};

async function resolveDefaultSessionTranscriptsDir(): Promise<string> {
  const { resolveSessionTranscriptsDir } = await import("../config/sessions.js");
  return resolveSessionTranscriptsDir();
}

async function readConfigFileRaw(configPath: string): Promise<{
  exists: boolean;
  parsed: OpenClawConfig;
}> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = safeParseWithSchema(JsonRecordSchema, JSON5.parse(raw));
    return { exists: true, parsed: (parsed ?? {}) as OpenClawConfig };
  } catch {
    return { exists: false, parsed: {} };
  }
}

export async function setupCommand(
  opts?: { workspace?: string },
  runtime: RuntimeEnv = defaultRuntime,
  deps: SetupCommandDeps = {},
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const io = createConfigIO();
  const configPath = io.configPath;
  const existingRaw = await readConfigFileRaw(configPath);
  const cfg = existingRaw.parsed;
  const defaults = cfg.agents?.defaults ?? {};

  const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;

  const next: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
    gateway: {
      ...cfg.gateway,
      mode: cfg.gateway?.mode ?? "local",
    },
  };

  if (
    !existingRaw.exists ||
    defaults.workspace !== workspace ||
    cfg.gateway?.mode !== next.gateway?.mode
  ) {
    await (deps.writeConfigFile ?? writeConfigFile)(next);
    if (!existingRaw.exists) {
      runtime.log(`Wrote ${formatConfigPath(configPath)}`);
    } else {
      const updates: string[] = [];
      if (defaults.workspace !== workspace) {
        updates.push("set agents.defaults.workspace");
      }
      if (cfg.gateway?.mode !== next.gateway?.mode) {
        updates.push("set gateway.mode");
      }
      const suffix = updates.length > 0 ? `(${updates.join(", ")})` : undefined;
      logConfigUpdated(runtime, { path: configPath, suffix });
    }
  } else {
    runtime.log(`Config OK: ${formatConfigPath(configPath)}`);
  }

  const ws = await (deps.ensureAgentWorkspace ?? ensureAgentWorkspace)({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const sessionsDir = await (
    deps.resolveSessionTranscriptsDir ?? resolveDefaultSessionTranscriptsDir
  )();
  await (deps.mkdir ?? fs.mkdir)(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
