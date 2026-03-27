import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { generateProjectMd, generateQueueMd } from "./templates.js";

export interface CreateProjectOpts {
  name: string;
  description?: string;
  owner?: string;
}

export interface CreateSubProjectOpts {
  name: string;
  parent: string;
  description?: string;
  owner?: string;
}

/** Write file atomically via tmp+rename to avoid partial reads. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Manages project directories under `<home>/.openclaw/projects/`.
 * Each project contains PROJECT.md, queue.md, and a tasks/ directory.
 */
export class ProjectManager {
  private readonly projectsRoot: string;

  constructor(homeDir?: string) {
    const home = homeDir ?? resolveRequiredHomeDir();
    this.projectsRoot = path.join(home, ".openclaw", "projects");
  }

  /**
   * Create a new project directory with scaffold files.
   * Throws if the project already exists (atomic mkdir check).
   */
  async create(opts: CreateProjectOpts): Promise<string> {
    const projectDir = path.join(this.projectsRoot, opts.name);

    // Ensure parent exists, then atomic mkdir for the project dir itself
    await fs.mkdir(this.projectsRoot, { recursive: true });
    try {
      await fs.mkdir(projectDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Project already exists at ${projectDir}`, { cause: err });
      }
      throw err;
    }

    // Create tasks/ with .gitkeep
    const tasksDir = path.join(projectDir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, ".gitkeep"), "", "utf-8");

    // Generate and write PROJECT.md and queue.md atomically
    await writeFileAtomic(path.join(projectDir, "PROJECT.md"), generateProjectMd(opts));
    await writeFileAtomic(path.join(projectDir, "queue.md"), generateQueueMd());

    return projectDir;
  }

  /**
   * Create a sub-project one level deep under a parent project.
   * Sub-projects live at `<parent>/sub-projects/<name>/` with the same
   * internal structure (PROJECT.md, queue.md, tasks/.gitkeep).
   */
  async createSubProject(opts: CreateSubProjectOpts): Promise<string> {
    const parentDir = path.join(this.projectsRoot, opts.parent);

    // Verify parent exists by checking for PROJECT.md
    try {
      await fs.access(path.join(parentDir, "PROJECT.md"));
    } catch {
      throw new Error(`Parent project '${opts.parent}' does not exist`);
    }

    // Ensure sub-projects/ directory exists, then atomic mkdir for the sub-project
    const subProjectsDir = path.join(parentDir, "sub-projects");
    await fs.mkdir(subProjectsDir, { recursive: true });

    const subDir = path.join(subProjectsDir, opts.name);
    try {
      await fs.mkdir(subDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Sub-project already exists at ${subDir}`, { cause: err });
      }
      throw err;
    }

    // Create tasks/ with .gitkeep
    const tasksDir = path.join(subDir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, ".gitkeep"), "", "utf-8");

    // Generate and write PROJECT.md and queue.md atomically
    await writeFileAtomic(
      path.join(subDir, "PROJECT.md"),
      generateProjectMd({ name: opts.name, description: opts.description, owner: opts.owner }),
    );
    await writeFileAtomic(path.join(subDir, "queue.md"), generateQueueMd());

    return subDir;
  }

  /**
   * Return the next sequential task ID for a project directory.
   * Scans `tasks/` for existing TASK-NNN.md files, finds the max, and
   * returns max+1 with at least 3-digit zero-padding.
   */
  async nextTaskId(projectDir: string): Promise<string> {
    const tasksDir = path.join(projectDir, "tasks");
    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir);
    } catch {
      // tasks/ doesn't exist — start at 1
      return "TASK-001";
    }

    const pattern = /^TASK-(\d+)\.md$/;
    let maxId = 0;
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxId) {
          maxId = num;
        }
      }
    }

    const next = maxId + 1;
    return `TASK-${String(next).padStart(3, "0")}`;
  }
}
