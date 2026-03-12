import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileLocker } from "../infra/file-locker.js";

// Interface for workspace options
export interface WorkspaceOptions {
  agentId: string;
  baseDir?: string;
  isolationEnabled?: boolean;
  copyOnWrite?: boolean;
  cleanupOnComplete?: boolean;
}

// Interface for agent workspace instances
interface AgentWorkspace {
  workspacePath: string;
  originalPaths?: Map<string, string>; // Maps temporary paths back to original paths
  isIsolated: boolean;
}

/**
 * WorkspaceManager handles creating and managing isolated workspaces for agents
 * to prevent file conflicts when multiple agents access shared resources.
 */
class WorkspaceManager {
  private static instance: WorkspaceManager;
  private agentWorkspaces: Map<string, AgentWorkspace> = new Map();
  private readonly baseWorkspaceDir: string;

  private constructor() {
    this.baseWorkspaceDir = path.join(os.tmpdir(), "openclaw-agent-workspaces");
  }

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  /**
   * Creates an isolated workspace for an agent
   * @param options Configuration options for the workspace
   * @returns Path to the agent's isolated workspace
   */
  async createWorkspace(options: WorkspaceOptions): Promise<string> {
    const agentId = options.agentId;
    const workspacePath = options.baseDir
      ? path.resolve(options.baseDir)
      : path.join(this.baseWorkspaceDir, agentId, Date.now().toString());

    // If isolation is disabled, return the original path or a default
    if (!options.isolationEnabled) {
      const defaultPath =
        options.baseDir || path.join(os.homedir(), ".openclaw", "workspace", agentId);
      const workspace: AgentWorkspace = {
        workspacePath: defaultPath,
        isIsolated: false,
      };
      this.agentWorkspaces.set(agentId, workspace);
      return defaultPath;
    }

    // Create the isolated workspace directory
    await fs.mkdir(workspacePath, { recursive: true });

    const workspace: AgentWorkspace = {
      workspacePath,
      isIsolated: true,
    };

    this.agentWorkspaces.set(agentId, workspace);
    return workspacePath;
  }

  /**
   * Gets the workspace path for an agent
   * @param agentId The ID of the agent
   * @returns The workspace path or undefined if not found
   */
  getWorkspacePath(agentId: string): string | undefined {
    const workspace = this.agentWorkspaces.get(agentId);
    return workspace?.workspacePath;
  }

  /**
   * Prepares a file for access in the agent's workspace, applying copy-on-write if needed
   * @param agentId The ID of the agent
   * @param originalPath The original path to the file
   * @returns Path to the file in the agent's workspace
   */
  async prepareFileForAgent(agentId: string, originalPath: string): Promise<string> {
    const workspace = this.agentWorkspaces.get(agentId);
    if (!workspace || !workspace.isIsolated) {
      return originalPath;
    }

    // Create a path in the agent's workspace that mirrors the original structure
    const relativePath = path.relative("/", originalPath.replace(/^[a-zA-Z]:[/\\]/, ""));
    const agentFilePath = path.join(workspace.workspacePath, relativePath);

    // Create directories if needed
    await fs.mkdir(path.dirname(agentFilePath), { recursive: true });

    // If copy-on-write is enabled and the file exists in the original location,
    // copy it to the agent's workspace
    if (workspace.originalPaths === undefined) {
      workspace.originalPaths = new Map();
    }

    try {
      const stats = await fs.stat(originalPath);
      if (stats.isFile()) {
        // Copy the file to the agent's workspace
        await fs.copyFile(originalPath, agentFilePath);
        workspace.originalPaths.set(agentFilePath, originalPath);
        return agentFilePath;
      }
    } catch {
      // If the original file doesn't exist, we'll work directly in the agent's workspace
      workspace.originalPaths.set(agentFilePath, originalPath);
    }

    return agentFilePath;
  }

  /**
   * Merges changes from an agent's workspace back to the original location
   * @param agentId The ID of the agent
   * @param mergeStrategy How to handle conflicts ("overwrite", "backup", "skip")
   */
  async mergeChangesBack(
    agentId: string,
    mergeStrategy: "overwrite" | "backup" | "skip" = "overwrite",
  ): Promise<void> {
    const workspace = this.agentWorkspaces.get(agentId);
    if (!workspace || !workspace.originalPaths) {
      return;
    }

    for (const [agentFilePath, originalPath] of workspace.originalPaths.entries()) {
      try {
        // Check if the file exists in the agent's workspace
        const stats = await fs.stat(agentFilePath);
        if (!stats.isFile()) {
          continue;
        }

        // Determine what to do based on the merge strategy
        let shouldCopy = true;
        if (mergeStrategy === "skip") {
          try {
            await fs.stat(originalPath);
            // Original file exists, so skip
            shouldCopy = false;
          } catch {
            // Original file doesn't exist, so copy
            shouldCopy = true;
          }
        } else if (mergeStrategy === "backup") {
          try {
            const originalStats = await fs.stat(originalPath);
            // If original file is newer, decide whether to backup or skip
            const agentFileMtime = stats.mtime;
            const originalMtime = originalStats.mtime;

            if (originalMtime > agentFileMtime) {
              shouldCopy = false; // Original is newer, skip
            } else {
              // Backup original file before overwriting
              const backupPath = `${originalPath}.backup.${Date.now()}`;
              await fs.copyFile(originalPath, backupPath);
            }
          } catch {
            // Original file doesn't exist, so just copy
          }
        }

        if (shouldCopy) {
          // Use file locking to prevent conflicts when writing
          await fileLocker.acquire(originalPath, async () => {
            await fs.copyFile(agentFilePath, originalPath);
          });
        }
      } catch (err) {
        console.warn(`Failed to merge ${agentFilePath} back to ${originalPath}:`, err);
      }
    }
  }

  /**
   * Cleans up the agent's workspace
   * @param agentId The ID of the agent
   * @param force If true, removes the workspace even if cleanupOnComplete is false
   */
  async cleanupWorkspace(agentId: string, force = false): Promise<void> {
    const workspace = this.agentWorkspaces.get(agentId);
    if (!workspace) {
      return;
    }

    if (workspace.isIsolated && (force || workspace.isIsolated)) {
      try {
        await fs.rm(workspace.workspacePath, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Failed to cleanup workspace ${workspace.workspacePath}:`, err);
      }
    }

    this.agentWorkspaces.delete(agentId);
  }
}

export const workspaceManager = WorkspaceManager.getInstance();

/**
 * Utility function to run a task in an agent's isolated workspace
 * @param agentId The ID of the agent
 * @param task The task to run in the workspace
 * @param options Workspace configuration options
 * @returns Promise that resolves to the result of the task
 */
export async function runInAgentWorkspace<T>(
  agentId: string,
  task: (workspacePath: string) => Promise<T>,
  options: WorkspaceOptions,
): Promise<T> {
  const workspacePath = await workspaceManager.createWorkspace({
    ...options,
    agentId,
  });

  try {
    const result = await task(workspacePath);
    await workspaceManager.mergeChangesBack(agentId, "overwrite"); // Merge changes back when done
    return result;
  } finally {
    if (options.cleanupOnComplete) {
      await workspaceManager.cleanupWorkspace(agentId);
    }
  }
}
