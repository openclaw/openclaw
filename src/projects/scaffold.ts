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
        throw new Error(`Project already exists at ${projectDir}`);
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
}
