import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveUserPath } from "../utils.js";

export const DEFAULT_AGENT_WORKSPACE_DIR = path.join(os.homedir(), "clawd");
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";

const DEFAULT_AGENTS_TEMPLATE = `# AGENTS.md - Clawdis Workspace

This folder is the assistant's working directory.

## Backup tip (recommended)
If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
and notes are backed up.

\`\`\`bash
git init
git add AGENTS.md
git commit -m "Add agent workspace"
\`\`\`

## Safety defaults
- Don't exfiltrate secrets or private data.
- Don't run destructive commands unless explicitly asked.
- Be concise in chat; write longer output to files in this workspace.

## Daily memory (recommended)
- Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
- On session start, read today + yesterday if present.
- Capture durable facts, preferences, and decisions; avoid secrets.

## Customize
- Add your preferred style, rules, and "memory" here.
`;

const DEFAULT_SOUL_TEMPLATE = `# SOUL.md - Persona & Boundaries

Describe who the assistant is, tone, and boundaries.

- Keep replies concise and direct.
- Ask clarifying questions when needed.
- Never send streaming/partial replies to external messaging surfaces.
`;

const DEFAULT_TOOLS_TEMPLATE = `# TOOLS.md - User Tool Notes (editable)

This file is for *your* notes about external tools and conventions.
It does not define which tools exist; Clawdis provides built-in tools internally.

## Examples

### imsg
- Send an iMessage/SMS: describe who/what, confirm before sending.
- Prefer short messages; avoid sending secrets.

### sag
- Text-to-speech: specify voice, target speaker/room, and whether to stream.

Add whatever else you want the assistant to know about your local toolchain.
`;

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/templates",
);

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return content;
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string, fallback: string): Promise<string> {
  const templatePath = path.join(TEMPLATE_DIR, name);
  try {
    const content = await fs.readFile(templatePath, "utf-8");
    return stripFrontMatter(content);
  } catch {
    return fallback;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") throw err;
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
}> {
  const rawDir = params?.dir?.trim()
    ? params.dir.trim()
    : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) return { dir };

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);

  const agentsTemplate = await loadTemplate(
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_AGENTS_TEMPLATE,
  );
  const soulTemplate = await loadTemplate(
    DEFAULT_SOUL_FILENAME,
    DEFAULT_SOUL_TEMPLATE,
  );
  const toolsTemplate = await loadTemplate(
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_TOOLS_TEMPLATE,
  );

  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);

  return { dir, agentsPath, soulPath, toolsPath };
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
  ];

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}
