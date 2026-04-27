import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import { isRecord } from "../utils.js";

const MEANINGFUL_WORKSPACE_ENTRIES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "skills",
] as const;

const MEANINGFUL_STATE_ENTRIES = ["credentials", "sessions", "agents"] as const;

async function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

async function hasDirectoryEntries(candidate: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(candidate);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function configLooksMeaningful(configPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return false;
  }
  if (!raw.trim()) {
    return false;
  }
  try {
    const parsed = JSON5.parse(raw);
    if (!isRecord(parsed)) {
      return true;
    }
    const keys = Object.keys(parsed).filter((key) => key !== "$schema" && key !== "meta");
    return keys.length > 0;
  } catch {
    return true;
  }
}

export async function inspectExistingOpenClawState(params: {
  targetStateDir: string;
  targetWorkspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ meaningful: boolean; reasons: string[] }> {
  const env = params.env ?? process.env;
  const reasons: string[] = [];
  const configPath = resolveConfigPath(env, params.targetStateDir);
  if (await configLooksMeaningful(configPath)) {
    reasons.push(`config exists: ${configPath}`);
  }
  for (const entry of MEANINGFUL_WORKSPACE_ENTRIES) {
    const candidate = path.join(params.targetWorkspaceDir, entry);
    if (await exists(candidate)) {
      reasons.push(`workspace ${entry} exists`);
    }
  }
  for (const entry of MEANINGFUL_STATE_ENTRIES) {
    const candidate = path.join(params.targetStateDir, entry);
    if (await hasDirectoryEntries(candidate)) {
      reasons.push(`state ${entry}/ exists`);
    }
  }
  return { meaningful: reasons.length > 0, reasons };
}
