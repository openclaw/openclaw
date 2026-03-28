import path from "node:path";
import * as p from "@clack/prompts";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { ProjectManager } from "../projects/scaffold.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsCreateOptions = {
  name?: string;
  description?: string;
  owner?: string;
  parent?: string;
  json?: boolean;
};

type ProjectsCreateContext = {
  homeDir?: string;
};

export async function projectsCreateCommand(
  opts: ProjectsCreateOptions,
  context: ProjectsCreateContext = {},
  runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  let { name, description, owner } = opts;

  // Interactive prompts when name not provided
  if (!name) {
    const nameResult = await p.text({ message: "Project name:" });
    if (p.isCancel(nameResult)) {
      return;
    }
    name = nameResult;

    const descResult = await p.text({ message: "Description (optional):" });
    if (!p.isCancel(descResult)) {
      description = descResult;
    }

    const ownerResult = await p.text({ message: "Owner (optional):" });
    if (!p.isCancel(ownerResult)) {
      owner = ownerResult;
    }
  }

  const manager = new ProjectManager(context.homeDir);

  try {
    let projectDir: string;
    if (opts.parent) {
      projectDir = await manager.createSubProject({
        name,
        parent: opts.parent,
        description,
        owner,
      });
    } else {
      projectDir = await manager.create({ name, description, owner });
    }

    if (opts.json) {
      runtime.writeJson({ path: projectDir, name });
    } else {
      runtime.log(`Created project at ${projectDir}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(message);

    // List available projects as suggestions on duplicate error
    if (message.includes("already exists")) {
      try {
        const home = context.homeDir ?? resolveRequiredHomeDir();
        const projectsRoot = path.join(home, ".openclaw", "projects");
        const syncService = new ProjectSyncService(projectsRoot);
        const projects = await syncService.discoverProjects();
        if (projects.length > 0) {
          const names = projects.map((dir) => path.basename(dir));
          runtime.error(`Existing projects: ${names.join(", ")}`);
        }
      } catch {
        // Ignore discovery errors
      }
    }

    runtime.exit(1);
  }
}
