import fs from "node:fs/promises";
import JSON5 from "json5";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { type OpenClawConfig, createConfigIO, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

function isParseError(err: unknown): boolean {
  return err instanceof SyntaxError || (err as Error | null)?.name === "SyntaxError";
}

async function readConfigFileRaw(configPath: string): Promise<{
  exists: boolean;
  parsed: OpenClawConfig;
  parseError?: boolean;
  readError?: unknown;
}> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { exists: true, parsed: parsed as OpenClawConfig };
    }
    return { exists: true, parsed: {} };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { exists: false, parsed: {} };
    }
    if (isParseError(err)) {
      return { exists: true, parsed: {}, parseError: true };
    }
    return { exists: true, parsed: {}, readError: err };
  }
}

export async function setupCommand(
  opts?: { workspace?: string },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const io = createConfigIO();
  const configPath = io.configPath;
  const existingRaw = await readConfigFileRaw(configPath);

  if (existingRaw.parseError) {
    throw new Error(
      `Config file exists but is not valid JSON: ${formatConfigPath(configPath)}. Fix the file before running setup.`,
    );
  }
  if (existingRaw.readError) {
    const message =
      existingRaw.readError instanceof Error
        ? existingRaw.readError.message
        : typeof existingRaw.readError === "string"
          ? existingRaw.readError
          : "Unknown error";
    throw new Error(`Config file could not be read: ${formatConfigPath(configPath)} — ${message}`, {
      cause: existingRaw.readError,
    });
  }

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
  };

  if (!existingRaw.exists || defaults.workspace !== workspace) {
    await writeConfigFile(next);
    if (!existingRaw.exists) {
      runtime.log(`Wrote ${formatConfigPath(configPath)}`);
    } else {
      logConfigUpdated(runtime, { path: configPath, suffix: "(set agents.defaults.workspace)" });
    }
  } else {
    runtime.log(`Config OK: ${formatConfigPath(configPath)}`);
  }

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
