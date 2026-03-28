import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { parseProjectFrontmatter } from "../projects/frontmatter.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";

export type ProjectsListOptions = {
  json?: boolean;
};

type ProjectsListContext = {
  homeDir?: string;
};

export async function projectsListCommand(
  opts: ProjectsListOptions = {},
  context: ProjectsListContext = {},
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

  const summaries: Array<{
    name: string;
    status: string;
    tasks: string;
    owner: string;
  }> = [];

  for (const projectDir of projectDirs) {
    let name = path.basename(projectDir);
    let status = "unknown";
    let owner = "";

    try {
      const content = await fs.readFile(path.join(projectDir, "PROJECT.md"), "utf-8");
      const result = parseProjectFrontmatter(content, "PROJECT.md");
      if (result.success) {
        name = result.data.name;
        status = result.data.status;
        owner = result.data.owner ?? "";
      }
    } catch {
      // Use defaults from directory name
    }

    // Count tasks in the tasks/ directory
    let taskCount = 0;
    try {
      const entries = await fs.readdir(path.join(projectDir, "tasks"));
      taskCount = entries.filter((e) => /^TASK-\d+\.md$/.test(e)).length;
    } catch {
      // tasks/ missing
    }

    summaries.push({
      name,
      status,
      tasks: String(taskCount),
      owner,
    });
  }

  if (opts.json) {
    runtime.writeJson(summaries);
    return;
  }

  const table = renderTable({
    columns: [
      { key: "name", header: "Name" },
      { key: "status", header: "Status" },
      { key: "tasks", header: "Tasks" },
      { key: "owner", header: "Owner" },
    ],
    rows: summaries,
    border: "unicode",
  });
  runtime.log(table);
}
