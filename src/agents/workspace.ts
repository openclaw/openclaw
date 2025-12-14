import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR, resolveUserPath } from "../utils.js";

export const DEFAULT_AGENT_WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";

const DEFAULT_AGENTS_TEMPLATE = `# AGENTS.md — Clawdis Workspace

This folder is the assistant’s working directory.

## Safety defaults
- Don’t exfiltrate secrets or private data.
- Don’t run destructive commands unless explicitly asked.
- Be concise in chat; write longer output to files in this workspace.

## How to use this
- Put project notes, scratch files, and “memory” here.
- Customize this file with additional instructions for your assistant.
`;

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureAgentsFile?: boolean;
}): Promise<{ dir: string; agentsPath?: string }> {
  const rawDir = params?.dir?.trim()
    ? params.dir.trim()
    : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureAgentsFile) return { dir };

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  try {
    await fs.writeFile(agentsPath, DEFAULT_AGENTS_TEMPLATE, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") throw err;
  }
  return { dir, agentsPath };
}
