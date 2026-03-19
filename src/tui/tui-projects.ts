import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type ProjectEntry = {
  id: string;
  name: string;
  path: string;
  description: string;
  agentId: string;
  upstreamRemote: string;
  templateRemote: string | null;
};

type ProjectsFile = {
  projects: ProjectEntry[];
};

function resolveProjectsPath(): string {
  return path.join(resolveStateDir(), "projects.json");
}

export function loadProjects(): ProjectEntry[] {
  const filePath = resolveProjectsPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ProjectsFile;
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectEntry[]): void {
  const filePath = resolveProjectsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: ProjectsFile = { projects };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8" });
}

export function findProject(id: string): ProjectEntry | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function registerProject(opts: {
  id: string;
  name: string;
  path: string;
  description?: string;
  agentId?: string;
  upstreamRemote?: string;
  templateRemote?: string | null;
}): ProjectEntry {
  const absPath = path.resolve(opts.path);
  if (!fs.existsSync(absPath)) {
    throw new Error(`path does not exist: ${absPath}`);
  }
  if (!fs.existsSync(path.join(absPath, ".git"))) {
    throw new Error(`not a git repository: ${absPath}`);
  }
  const projects = loadProjects();
  if (projects.some((p) => p.id === opts.id)) {
    throw new Error(`project "${opts.id}" already registered`);
  }
  const entry: ProjectEntry = {
    id: opts.id,
    name: opts.name,
    path: absPath,
    description: opts.description ?? "",
    agentId: opts.agentId ?? "main",
    upstreamRemote: opts.upstreamRemote ?? "upstream",
    templateRemote: opts.templateRemote ?? null,
  };
  projects.push(entry);
  saveProjects(projects);
  return entry;
}

export function removeProject(id: string): boolean {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) {
    return false;
  }
  projects.splice(idx, 1);
  saveProjects(projects);
  return true;
}

/** Scaffold a new openclaw-based project by cloning the local repo. */
export function scaffoldProject(opts: {
  id: string;
  name: string;
  targetPath: string;
  sourceRepo?: string;
  upstreamUrl?: string;
}): ProjectEntry {
  const absTarget = path.resolve(opts.targetPath);
  if (fs.existsSync(absTarget)) {
    throw new Error(`target path already exists: ${absTarget}`);
  }

  const sourceRepo = opts.sourceRepo ?? "https://github.com/openclaw/openclaw";
  const upstreamUrl = opts.upstreamUrl ?? "https://github.com/openclaw/openclaw";

  execSync(`git clone "${sourceRepo}" "${absTarget}"`, { stdio: "pipe" });

  // Ensure upstream remote exists and points to openclaw
  try {
    execSync(`git remote add upstream "${upstreamUrl}"`, { cwd: absTarget, stdio: "pipe" });
  } catch {
    execSync(`git remote set-url upstream "${upstreamUrl}"`, { cwd: absTarget, stdio: "pipe" });
  }

  return registerProject({
    id: opts.id,
    name: opts.name,
    path: absTarget,
    upstreamRemote: "upstream",
  });
}

export type SyncResult = {
  ok: boolean;
  output: string;
  error?: string;
};

/** Fetch and rebase a project from its upstream (and optionally template) remote. */
export function syncProject(project: ProjectEntry): SyncResult {
  if (!fs.existsSync(project.path)) {
    return { ok: false, output: "", error: `project path not found: ${project.path}` };
  }

  const lines: string[] = [];
  try {
    const fetchOut = execSync(`git fetch ${project.upstreamRemote}`, {
      cwd: project.path,
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (fetchOut.trim()) {
      lines.push(fetchOut.trim());
    }

    const rebaseOut = execSync(`git rebase ${project.upstreamRemote}/main`, {
      cwd: project.path,
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (rebaseOut.trim()) {
      lines.push(rebaseOut.trim());
    }
    lines.push(`rebased onto ${project.upstreamRemote}/main`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: lines.join("\n"), error: msg };
  }

  if (project.templateRemote) {
    try {
      execSync(`git fetch ${project.templateRemote}`, {
        cwd: project.path,
        stdio: "pipe",
        encoding: "utf-8",
      });
      execSync(`git rebase ${project.templateRemote}/main`, {
        cwd: project.path,
        stdio: "pipe",
        encoding: "utf-8",
      });
      lines.push(`rebased onto ${project.templateRemote}/main`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`template sync warning: ${msg}`);
    }
  }

  return { ok: true, output: lines.join("\n") };
}

/** Sync all registered projects, returning per-project results. */
export function syncAllProjects(): Array<{ project: ProjectEntry; result: SyncResult }> {
  return loadProjects().map((project) => ({
    project,
    result: syncProject(project),
  }));
}
