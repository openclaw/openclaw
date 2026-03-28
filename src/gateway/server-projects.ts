import fs from "node:fs/promises";
import path from "node:path";
import type { CheckpointData } from "../projects/checkpoint.js";
import { checkpointPath, readCheckpoint } from "../projects/checkpoint.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { BoardIndex, ProjectIndex, QueueIndex, SyncEvent } from "../projects/sync-types.js";
import type { GatewayBroadcastFn } from "./server-broadcast.js";

/**
 * Bridges ProjectSyncService to the gateway WebSocket infrastructure.
 *
 * Manages the sync service lifecycle and translates SyncEvent emissions
 * into broadcast() calls so the UI receives live project change notifications.
 * Also exposes data-read methods for the RPC handlers.
 */
export class ProjectGatewayService {
  private readonly projectsRoot: string;
  private readonly broadcast: GatewayBroadcastFn;
  private syncService: ProjectSyncService | null = null;
  private syncHandler: ((event: SyncEvent) => void) | null = null;

  constructor(projectsRoot: string, broadcast: GatewayBroadcastFn) {
    this.projectsRoot = projectsRoot;
    this.broadcast = broadcast;
  }

  async start(): Promise<void> {
    this.syncService = new ProjectSyncService(this.projectsRoot);
    this.syncHandler = (event: SyncEvent) => this.handleSyncEvent(event);
    this.syncService.on("sync", this.syncHandler);
    await this.syncService.start();
  }

  async stop(): Promise<void> {
    if (this.syncService) {
      if (this.syncHandler) {
        this.syncService.removeListener("sync", this.syncHandler);
        this.syncHandler = null;
      }
      await this.syncService.stop();
      this.syncService = null;
    }
  }

  private handleSyncEvent(event: SyncEvent): void {
    switch (event.type) {
      case "project:changed":
        this.broadcast("projects.changed", { project: event.project });
        break;
      case "task:changed":
      case "task:deleted":
        this.broadcast("projects.board.changed", { project: event.project });
        break;
      case "queue:changed":
        this.broadcast("projects.queue.changed", { project: event.project });
        break;
      case "reindex:complete":
        // Internal-only event; no broadcast needed
        break;
    }
  }

  /**
   * Discover all projects and read their .index/project.json.
   * Returns an array with project name and index data.
   */
  async listProjects(): Promise<Array<{ name: string } & ProjectIndex>> {
    if (!this.syncService) {
      return [];
    }
    const projectDirs = await this.syncService.discoverProjects();
    const results: Array<{ name: string } & ProjectIndex> = [];

    for (const projectDir of projectDirs) {
      const name = path.basename(projectDir);
      const data = await this.readJsonFile<ProjectIndex>(
        path.join(projectDir, ".index", "project.json"),
      );
      if (data) {
        results.push({ name, ...data });
      }
    }

    return results;
  }

  /** Read a single project's index data. */
  async getProject(name: string): Promise<ProjectIndex | null> {
    return this.readJsonFile<ProjectIndex>(
      path.join(this.projectsRoot, name, ".index", "project.json"),
    );
  }

  /** Read a project's board index. */
  async getBoard(name: string): Promise<BoardIndex | null> {
    return this.readJsonFile<BoardIndex>(
      path.join(this.projectsRoot, name, ".index", "board.json"),
    );
  }

  /** Read a project's queue index. */
  async getQueue(name: string): Promise<QueueIndex | null> {
    return this.readJsonFile<QueueIndex>(
      path.join(this.projectsRoot, name, ".index", "queue.json"),
    );
  }

  /** Read a task's checkpoint sidecar file. Returns null if not found. */
  async getTaskCheckpoint(projectName: string, taskId: string): Promise<CheckpointData | null> {
    const taskFile = path.join(this.projectsRoot, projectName, "tasks", `${taskId}.md`);
    const cpPath = checkpointPath(taskFile);
    return readCheckpoint(cpPath);
  }

  /** Read and parse a JSON file, returning null on ENOENT or parse error. */
  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
