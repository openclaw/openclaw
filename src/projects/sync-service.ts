import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { parseProjectFrontmatter, parseTaskFrontmatter } from "./frontmatter.js";
import {
  generateAllIndexes,
  generateBoardIndex,
  generateProjectIndex,
  generateQueueIndex,
  generateTaskIndex,
  writeIndexFile,
} from "./index-generator.js";
import { parseQueue } from "./queue-parser.js";
import type { SyncEvent } from "./sync-types.js";
import type { TaskFrontmatter } from "./types.js";

/**
 * Watches project markdown files for changes, debounces updates per-project,
 * triggers incremental index regeneration, and performs full reindex on startup.
 *
 * Emits `"sync"` events (typed as SyncEvent) for downstream consumers
 * (Gateway WebSocket, UI).
 */
export class ProjectSyncService extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly projectsRoot: string;

  constructor(projectsRoot: string) {
    super();
    this.projectsRoot = projectsRoot;
  }

  /**
   * Discover all project directories (those containing PROJECT.md).
   * Checks top-level and one level of sub-projects at `<project>/sub-projects/<child>/`.
   */
  async discoverProjects(): Promise<string[]> {
    const projects: string[] = [];
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.projectsRoot);
    } catch {
      return projects;
    }

    for (const entry of entries) {
      const entryPath = path.join(this.projectsRoot, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat?.isDirectory()) {
        continue;
      }

      // Check if this is a project directory
      const hasProjectMd = await fs
        .access(path.join(entryPath, "PROJECT.md"))
        .then(() => true)
        .catch(() => false);

      if (hasProjectMd) {
        projects.push(entryPath);
      }

      // Check for sub-projects
      const subProjectsDir = path.join(entryPath, "sub-projects");
      let subEntries: string[] = [];
      try {
        subEntries = await fs.readdir(subProjectsDir);
      } catch {
        continue;
      }

      for (const sub of subEntries) {
        const subPath = path.join(subProjectsDir, sub);
        const subStat = await fs.stat(subPath).catch(() => null);
        if (!subStat?.isDirectory()) {
          continue;
        }

        const subHasProjectMd = await fs
          .access(path.join(subPath, "PROJECT.md"))
          .then(() => true)
          .catch(() => false);

        if (subHasProjectMd) {
          projects.push(subPath);
        }
      }
    }

    return projects;
  }

  /**
   * Run full reindex on all projects, then start watching for changes.
   */
  async start(): Promise<void> {
    // 1. Discover and reindex all projects
    const projectDirs = await this.discoverProjects();

    for (const projectDir of projectDirs) {
      try {
        const events = await generateAllIndexes(projectDir);
        for (const event of events) {
          this.emit("sync", event);
        }
      } catch (err) {
        this.emit("error", err);
      }
    }

    // 2. Start chokidar watcher
    this.watcher = chokidar.watch(this.projectsRoot, {
      ignoreInitial: true,
      ignored: [/(^|[/\\])\.index/, /(^|[/\\])\.lock/, /(^|[/\\])node_modules/],
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      depth: 5,
    });

    this.watcher.on("add", (filePath: string) => this.handleFileChange(filePath));
    this.watcher.on("change", (filePath: string) => this.handleFileChange(filePath));
    this.watcher.on("unlink", (filePath: string) => this.handleFileDelete(filePath));
  }

  /**
   * Close watcher and clear all debounce timers.
   */
  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private handleFileChange(filePath: string): void {
    if (!filePath.endsWith(".md")) {
      return;
    }
    const resolved = this.resolveProjectDir(filePath);
    if (!resolved) {
      return;
    }
    this.scheduleUpdate(resolved.projectName, filePath, "change");
  }

  private handleFileDelete(filePath: string): void {
    if (!filePath.endsWith(".md")) {
      return;
    }
    const resolved = this.resolveProjectDir(filePath);
    if (!resolved) {
      return;
    }
    this.scheduleUpdate(resolved.projectName, filePath, "delete");
  }

  /**
   * Per-project debounce: batches rapid changes into a single update.
   */
  private scheduleUpdate(projectName: string, filePath: string, action: "change" | "delete"): void {
    const existing = this.debounceTimers.get(projectName);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      projectName,
      setTimeout(() => {
        this.debounceTimers.delete(projectName);
        void this.processUpdate(projectName, filePath, action).catch((err) => {
          this.emit("error", err);
        });
      }, 300),
    );
  }

  /**
   * Incremental index update based on which file changed.
   */
  private async processUpdate(
    projectName: string,
    filePath: string,
    action: "change" | "delete",
  ): Promise<void> {
    const resolved = this.resolveProjectDir(filePath);
    if (!resolved) {
      return;
    }
    const { projectDir } = resolved;
    const indexDir = path.join(projectDir, ".index");
    const basename = path.basename(filePath);
    const relative = path.relative(projectDir, filePath);

    try {
      if (basename === "PROJECT.md") {
        // Regenerate project.json only
        const content = await fs.readFile(filePath, "utf-8");
        const result = parseProjectFrontmatter(content, basename);
        if (result.success) {
          const projectIndex = generateProjectIndex(result.data);
          await writeIndexFile(path.join(indexDir, "project.json"), projectIndex);
          const event: SyncEvent = { type: "project:changed", project: projectName };
          this.emit("sync", event);
        }
      } else if (basename === "queue.md") {
        // Regenerate queue.json only
        const content = await fs.readFile(filePath, "utf-8");
        const parsedQueue = parseQueue(content, basename);
        const queueIndex = generateQueueIndex(parsedQueue);
        await writeIndexFile(path.join(indexDir, "queue.json"), queueIndex);
        const event: SyncEvent = { type: "queue:changed", project: projectName };
        this.emit("sync", event);
      } else if (relative.startsWith("tasks/") && /^TASK-\d+\.md$/.test(basename)) {
        const taskId = basename.replace(".md", "");
        const tasksIndexDir = path.join(indexDir, "tasks");

        if (action === "delete") {
          // Remove task JSON and regenerate board
          await fs.unlink(path.join(tasksIndexDir, `${taskId}.json`)).catch(() => {});
          await this.regenerateBoard(projectDir, projectName);
          const event: SyncEvent = { type: "task:deleted", project: projectName, taskId };
          this.emit("sync", event);
        } else {
          // Regenerate task JSON and board
          const content = await fs.readFile(filePath, "utf-8");
          const result = parseTaskFrontmatter(content, basename);
          if (result.success) {
            const taskIndex = generateTaskIndex(result.data);
            await writeIndexFile(path.join(tasksIndexDir, `${taskId}.json`), taskIndex);
            await this.regenerateBoard(projectDir, projectName);
            const event: SyncEvent = { type: "task:changed", project: projectName, taskId };
            this.emit("sync", event);
          }
        }
      }
    } catch {
      // Parse failure or read error -- skip (D-09)
    }
  }

  /**
   * Regenerate board.json by reading all task files and project columns.
   */
  private async regenerateBoard(projectDir: string, _projectName: string): Promise<void> {
    const tasksDir = path.join(projectDir, "tasks");
    const indexDir = path.join(projectDir, ".index");

    // Get columns from project frontmatter
    let columns = ["Backlog", "In Progress", "Review", "Done"];
    try {
      const projectContent = await fs.readFile(path.join(projectDir, "PROJECT.md"), "utf-8");
      const result = parseProjectFrontmatter(projectContent, "PROJECT.md");
      if (result.success) {
        columns = result.data.columns;
      }
    } catch {
      // Use defaults
    }

    // Read all task files
    const validTasks: TaskFrontmatter[] = [];
    try {
      const entries = await fs.readdir(tasksDir);
      const taskFiles = entries.filter((f) => /^TASK-\d+\.md$/.test(f)).toSorted();

      for (const taskFile of taskFiles) {
        try {
          const content = await fs.readFile(path.join(tasksDir, taskFile), "utf-8");
          const result = parseTaskFrontmatter(content, taskFile);
          if (result.success) {
            validTasks.push(result.data);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // tasks/ missing
    }

    const boardIndex = generateBoardIndex(validTasks, columns);
    await writeIndexFile(path.join(indexDir, "board.json"), boardIndex);
  }

  /**
   * Resolve a file path to its project directory and name.
   * Handles both top-level projects and sub-projects.
   */
  private resolveProjectDir(filePath: string): { projectName: string; projectDir: string } | null {
    const relative = path.relative(this.projectsRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    const parts = relative.split(path.sep);
    if (parts.length < 1) {
      return null;
    }

    // Check if this is a sub-project path: <project>/sub-projects/<child>/...
    if (parts.length >= 3 && parts[1] === "sub-projects") {
      const projectDir = path.join(this.projectsRoot, parts[0], parts[1], parts[2]);
      return { projectName: parts[2], projectDir };
    }

    // Top-level project: <project>/...
    const projectDir = path.join(this.projectsRoot, parts[0]);
    return { projectName: parts[0], projectDir };
  }
}
