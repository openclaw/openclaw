import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  parseProjectFrontmatter,
  parseQueueFrontmatter,
  parseTaskFrontmatter,
} from "../projects/frontmatter.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsValidateOptions = {
  json?: boolean;
};

type ProjectsValidateContext = {
  homeDir?: string;
};

interface ValidationError {
  file: string;
  error: string;
}

export async function projectsValidateCommand(
  opts: ProjectsValidateOptions = {},
  context: ProjectsValidateContext = {},
  runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  const home = context.homeDir ?? resolveRequiredHomeDir();
  const projectsRoot = path.join(home, ".openclaw", "projects");
  const syncService = new ProjectSyncService(projectsRoot);
  const projectDirs = await syncService.discoverProjects();

  if (projectDirs.length === 0) {
    runtime.log("No projects found. Create one with: openclaw projects create <name>");
    return;
  }

  const errors: ValidationError[] = [];
  let fileCount = 0;

  for (const projectDir of projectDirs) {
    // Validate PROJECT.md
    const projectMdPath = path.join(projectDir, "PROJECT.md");
    try {
      const content = await fs.readFile(projectMdPath, "utf-8");
      fileCount++;
      const result = parseProjectFrontmatter(content, "PROJECT.md");
      if (!result.success) {
        errors.push({ file: projectMdPath, error: result.error.message });
      }
    } catch {
      // PROJECT.md missing — skip
    }

    // Validate queue.md
    const queuePath = path.join(projectDir, "queue.md");
    try {
      const content = await fs.readFile(queuePath, "utf-8");
      fileCount++;
      const queueResult = parseQueueFrontmatter(content, queuePath);
      if (!queueResult.success) {
        errors.push({ file: queuePath, error: queueResult.error.message });
      }
    } catch {
      // queue.md missing — skip
    }

    // Validate task files
    const tasksDir = path.join(projectDir, "tasks");
    try {
      const entries = await fs.readdir(tasksDir);
      const taskFiles = entries.filter((f) => /^TASK-\d+\.md$/.test(f));

      for (const taskFile of taskFiles) {
        const taskPath = path.join(tasksDir, taskFile);
        try {
          const content = await fs.readFile(taskPath, "utf-8");
          fileCount++;
          const result = parseTaskFrontmatter(content, taskFile);
          if (!result.success) {
            errors.push({ file: taskPath, error: result.error.message });
          }
        } catch {
          // Unreadable file — skip
        }
      }
    } catch {
      // tasks/ missing
    }
  }

  if (opts.json) {
    runtime.writeJson(errors);
    return;
  }

  if (errors.length > 0) {
    for (const err of errors) {
      runtime.error(`${err.file}: ${err.error}`);
    }
    runtime.error(`\n${errors.length} validation error(s) found.`);
    runtime.exit(1);
    return;
  }

  runtime.log(
    `All files valid. Checked ${fileCount} file(s) across ${projectDirs.length} project(s).`,
  );
}
