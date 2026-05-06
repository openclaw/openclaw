import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AgentWorkerPermissionRoots = {
  workspaceDir: string;
  agentDir?: string;
  sessionFile?: string;
  storePath?: string;
  readRoots?: string[];
  writeRoots?: string[];
};

function normalizeRoot(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolve(trimmed);
}

function addRoot(target: Set<string>, path: string | undefined): void {
  const normalized = normalizeRoot(path);
  if (normalized) {
    target.add(normalized);
  }
}

function addMutableFileRoots(params: {
  readRoots: Set<string>;
  writeRoots: Set<string>;
  filePath: string | undefined;
}): void {
  const filePath = normalizeRoot(params.filePath);
  if (!filePath) {
    return;
  }
  const lockPath = `${filePath}.lock`;
  addRoot(params.readRoots, filePath);
  addRoot(params.readRoots, lockPath);
  addRoot(params.writeRoots, filePath);
  addRoot(params.writeRoots, lockPath);
  addRoot(params.writeRoots, `${dirname(filePath)}/*`);
}

function addNodeModuleReadRoots(target: Set<string>): void {
  let current = dirname(fileURLToPath(import.meta.url));
  let previous = "";
  while (current !== previous) {
    addRoot(target, `${current}/node_modules/*`);
    previous = current;
    current = dirname(current);
  }
}

function addRuntimeReadRoots(target: Set<string>): void {
  let current = dirname(fileURLToPath(import.meta.url));
  let previous = "";
  while (current !== previous) {
    const name = basename(current);
    if (name === "dist" || name === "src") {
      addRoot(target, `${current}/*`);
    }
    if (name === "src") {
      addRoot(target, `${dirname(current)}/extensions/*`);
    }
    previous = current;
    current = dirname(current);
  }
}

export function buildAgentWorkerPermissionExecArgv(roots: AgentWorkerPermissionRoots): string[] {
  const readRoots = new Set<string>();
  const writeRoots = new Set<string>();

  addRoot(readRoots, `${roots.workspaceDir}/*`);
  addRoot(writeRoots, `${roots.workspaceDir}/*`);

  addRoot(readRoots, roots.agentDir ? `${roots.agentDir}/*` : undefined);
  addRoot(writeRoots, roots.agentDir ? `${roots.agentDir}/*` : undefined);

  addMutableFileRoots({ readRoots, writeRoots, filePath: roots.sessionFile });
  addMutableFileRoots({ readRoots, writeRoots, filePath: roots.storePath });

  for (const root of roots.readRoots ?? []) {
    addRoot(readRoots, root);
  }
  for (const root of roots.writeRoots ?? []) {
    addRoot(writeRoots, root);
  }

  addNodeModuleReadRoots(readRoots);
  addRuntimeReadRoots(readRoots);

  const args = ["--permission"];
  for (const root of [...readRoots].toSorted()) {
    args.push(`--allow-fs-read=${root}`);
  }
  for (const root of [...writeRoots].toSorted()) {
    args.push(`--allow-fs-write=${root}`);
  }
  return args;
}
