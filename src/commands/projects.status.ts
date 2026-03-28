import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { parseProjectFrontmatter, parseTaskFrontmatter } from "../projects/frontmatter.js";
import { parseQueue } from "../projects/queue-parser.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";

export type ProjectsStatusOptions = {
  name: string;
  json?: boolean;
};

type ProjectsStatusContext = {
  homeDir?: string;
};

export async function projectsStatusCommand(
  opts: ProjectsStatusOptions,
  context: ProjectsStatusContext = {},
  runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  const home = context.homeDir ?? resolveRequiredHomeDir();
  const projectsRoot = path.join(home, ".openclaw", "projects");
  const projectDir = path.join(projectsRoot, opts.name);

  // Check if project exists
  try {
    await fs.access(projectDir);
  } catch {
    runtime.error(`Project not found: ${opts.name}`);

    // List available projects as suggestions
    try {
      const syncService = new ProjectSyncService(projectsRoot);
      const projects = await syncService.discoverProjects();
      if (projects.length > 0) {
        const names = projects.map((d) => path.basename(d));
        runtime.error(`Available projects: ${names.join(", ")}`);
      }
    } catch {
      // Ignore discovery errors
    }

    runtime.exit(1);
    return;
  }

  // Read project frontmatter
  let projectName = opts.name;
  let projectStatus = "unknown";
  let projectDescription: string | undefined;

  try {
    const content = await fs.readFile(path.join(projectDir, "PROJECT.md"), "utf-8");
    const result = parseProjectFrontmatter(content, "PROJECT.md");
    if (result.success) {
      projectName = result.data.name;
      projectStatus = result.data.status;
      projectDescription = result.data.description;
    }
  } catch {
    // Use defaults
  }

  // Read and group tasks by status
  const taskCounts: Record<string, number> = {};
  try {
    const tasksDir = path.join(projectDir, "tasks");
    const entries = await fs.readdir(tasksDir);
    const taskFiles = entries.filter((f) => /^TASK-\d+\.md$/.test(f));

    for (const taskFile of taskFiles) {
      try {
        const content = await fs.readFile(path.join(tasksDir, taskFile), "utf-8");
        const result = parseTaskFrontmatter(content, taskFile);
        if (result.success) {
          const status = result.data.status;
          taskCounts[status] = (taskCounts[status] ?? 0) + 1;
        }
      } catch {
        // Skip unreadable task files
      }
    }
  } catch {
    // tasks/ missing
  }

  // Read queue for claimed tasks / active agents
  const activeAgents: Array<{ agent: string; taskId: string }> = [];
  try {
    const queueContent = await fs.readFile(path.join(projectDir, "queue.md"), "utf-8");
    const parsedQueue = parseQueue(queueContent, "queue.md");
    for (const entry of parsedQueue.claimed) {
      const agent = entry.metadata.agent;
      if (agent) {
        activeAgents.push({ agent, taskId: entry.taskId });
      }
    }
  } catch {
    // queue.md missing
  }

  if (opts.json) {
    runtime.writeJson({
      name: projectName,
      status: projectStatus,
      description: projectDescription,
      taskCounts,
      activeAgents,
    });
    return;
  }

  // Text output: header
  runtime.log(`Project: ${projectName} (${projectStatus})`);

  // Task counts table
  if (Object.keys(taskCounts).length > 0) {
    runtime.log("\nTask Counts by Status:");
    const rows = Object.entries(taskCounts).map(([status, count]) => ({
      status,
      count: String(count),
    }));
    const table = renderTable({
      columns: [
        { key: "status", header: "Status" },
        { key: "count", header: "Count" },
      ],
      rows,
      border: "unicode",
    });
    runtime.log(table);
  }

  // Active agents table
  if (activeAgents.length > 0) {
    runtime.log("\nActive Agents:");
    const agentRows = activeAgents.map((a) => ({
      agent: a.agent,
      taskId: a.taskId,
    }));
    const agentTable = renderTable({
      columns: [
        { key: "agent", header: "Agent" },
        { key: "taskId", header: "Task" },
      ],
      rows: agentRows,
      border: "unicode",
    });
    runtime.log(agentTable);
  }
}
