import fs from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import {
  ensureAgentWorkspace,
  portableDefaultAgentWorkspacePath,
  workspaceResolvedDirToConfigValue,
} from "../agents/workspace.js";
import { type OpenClawConfig, createConfigIO, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";

const JsonRecordSchema = z.record(z.string(), z.unknown());

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

  const rawWorkspace =
    desiredWorkspace ||
    (typeof defaults.workspace === "string" ? defaults.workspace.trim() : "") ||
    portableDefaultAgentWorkspacePath();
  const resolvedWorkspace = resolveUserPath(rawWorkspace);
  // For the default workspace, store the portable ~/.openclaw/workspace form;
  // for custom paths, preserve the user's original text (e.g. ~/my-workspace).
  const resolvedDefault = workspaceResolvedDirToConfigValue(resolvedWorkspace);
  const workspace = resolvedDefault !== resolvedWorkspace ? resolvedDefault : rawWorkspace;

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
    await writeConfigFile(next);
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

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
