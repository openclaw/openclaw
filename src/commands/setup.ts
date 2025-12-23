import fs from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";

import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import { type ClawdisConfig, CONFIG_PATH_CLAWDIS } from "../config/config.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

async function readConfigFileRaw(): Promise<{
  exists: boolean;
  parsed: ClawdisConfig;
}> {
  try {
    const raw = await fs.readFile(CONFIG_PATH_CLAWDIS, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { exists: true, parsed: parsed as ClawdisConfig };
    }
    return { exists: true, parsed: {} };
  } catch {
    return { exists: false, parsed: {} };
  }
}

async function writeConfigFile(cfg: ClawdisConfig) {
  await fs.mkdir(path.dirname(CONFIG_PATH_CLAWDIS), { recursive: true });
  const json = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
  await fs.writeFile(CONFIG_PATH_CLAWDIS, json, "utf-8");
}

export async function setupCommand(
  opts?: { workspace?: string },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const existingRaw = await readConfigFileRaw();
  const cfg = existingRaw.parsed;
  const inbound = cfg.inbound ?? {};
  const agent = cfg.agent ?? {};

  const workspace =
    desiredWorkspace ?? agent.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;

  const next: ClawdisConfig = {
    ...cfg,
    agent: {
      ...agent,
      workspace,
    },
  };

  if (!existingRaw.exists || agent.workspace !== workspace) {
    await writeConfigFile(next);
    runtime.log(
      !existingRaw.exists
        ? `Wrote ${CONFIG_PATH_CLAWDIS}`
        : `Updated ${CONFIG_PATH_CLAWDIS} (set agent.workspace)`,
    );
  } else {
    runtime.log(`Config OK: ${CONFIG_PATH_CLAWDIS}`);
  }

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: true,
  });
  runtime.log(`Workspace OK: ${ws.dir}`);

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${sessionsDir}`);
}
