/**
 * Team Storage Operations
 * Filesystem operations for team configuration and directories
 */

import { constants } from "fs";
import { access, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";

/**
 * Team name validation regex
 * Allows only lowercase letters, numbers, and hyphens, 1-50 characters
 */
const TEAM_NAME_REGEX = /^[a-z0-9-]{1,50}$/;

/**
 * Get the base directory for teams
 * Teams are stored under a "teams" subdirectory of the state directory.
 *
 * For teammate agents, the cwd and OPENCLAW_STATE_DIR may not point to the
 * parent agent's workspace (where the team was created). In that case we
 * walk up from the teammate's own workspace/agent directory — which lives
 * inside the team structure at {teamsDir}/{teamName}/agents/{name}/ — to
 * find the enclosing teams directory.
 *
 * @returns The teams base directory path
 */
export function getTeamsBaseDir(): string {
  // 1. Explicit env always wins
  if (process.env.OPENCLAW_STATE_DIR) {
    return join(process.env.OPENCLAW_STATE_DIR, "teams");
  }

  // 2. Check if cwd is inside a team structure:
  //    .../teams/<teamName>/agents/<name>/workspace  (teammate workspace)
  //    .../teams/<teamName>/agents/<name>/agent       (teammate agent dir)
  //    Match pattern: /teams/<x>/agents/<y>/
  const cwd = process.cwd();
  const teamsMatch = cwd.match(/^(.+\/teams)\/[^/]+\/agents\/[^/]+/);
  if (teamsMatch) {
    return teamsMatch[1];
  }

  // 3. Default: teams dir under cwd
  return join(cwd, "teams");
}

/**
 * Validate team name format
 */
export function validateTeamName(teamName: string): boolean {
  return typeof teamName === "string" && TEAM_NAME_REGEX.test(teamName);
}

/**
 * Validate team name and throw if invalid
 */
export function validateTeamNameOrThrow(teamName: string): void {
  if (!validateTeamName(teamName)) {
    throw new Error(
      `Invalid team name: ${teamName}. Must contain only lowercase letters, numbers, and hyphens`,
    );
  }
}

/**
 * Get team directory path
 */
export function getTeamDirectory(teamsDir: string, teamName: string): string {
  return join(teamsDir, teamName);
}

/**
 * Get team config file path
 */
export function getTeamConfigPath(teamsDir: string, teamName: string): string {
  return join(getTeamDirectory(teamsDir, teamName), "config.json");
}

/**
 * Check if team directory exists
 */
export async function teamDirectoryExists(teamsDir: string, teamName: string): Promise<boolean> {
  const teamPath = getTeamDirectory(teamsDir, teamName);
  try {
    await access(teamPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create team directory with required subdirectories
 */
export async function createTeamDirectory(teamsDir: string, teamName: string): Promise<void> {
  validateTeamNameOrThrow(teamName);
  const teamPath = getTeamDirectory(teamsDir, teamName);
  const tasksPath = join(teamPath, "tasks");
  const messagesPath = join(teamPath, "messages");
  const inboxPath = join(teamPath, "inbox");

  await mkdir(teamPath, { recursive: true });
  await mkdir(tasksPath, { recursive: true });
  await mkdir(messagesPath, { recursive: true });
  await mkdir(inboxPath, { recursive: true });
}

/**
 * Write team configuration atomically
 */
export async function writeTeamConfig(
  teamsDir: string,
  teamName: string,
  config: unknown,
): Promise<void> {
  validateTeamNameOrThrow(teamName);
  const configPath = getTeamConfigPath(teamsDir, teamName);
  const tempPath = `${configPath}.tmp`;
  const content = JSON.stringify(config, null, 2);

  await writeFile(tempPath, content, { mode: 0o600 });
  await writeFile(configPath, content, { mode: 0o600 });
  try {
    await rm(tempPath);
  } catch {
    // Temp file may already be cleaned up
  }
}

/**
 * Read team configuration
 */
export async function readTeamConfig(teamsDir: string, teamName: string): Promise<unknown> {
  validateTeamNameOrThrow(teamName);
  const configPath = getTeamConfigPath(teamsDir, teamName);
  const content = await readFile(configPath, "utf-8");
  return JSON.parse(content);
}

/**
 * Delete team directory
 */
export async function deleteTeamDirectory(teamsDir: string, teamName: string): Promise<void> {
  validateTeamNameOrThrow(teamName);
  const teamPath = getTeamDirectory(teamsDir, teamName);
  await rm(teamPath, { recursive: true, force: true });
}

/**
 * Helper function for atomic file writes
 * Writes to a temporary file first, then writes to target path
 * @param filePath - Target file path
 * @param content - Content to write
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;

  await writeFile(tempPath, content, { mode: 0o600 });
  await writeFile(filePath, content, { mode: 0o600 });

  try {
    await rm(tempPath);
  } catch {
    // Ignore cleanup errors - temp file will be cleaned up on next write
  }
}
