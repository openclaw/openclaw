import fs from "node:fs";
import path from "node:path";

type IsMainModuleOptions = {
  currentFile: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  wrapperEntryPairs?: Array<{
    wrapperBasename: string;
    entryBasename: string;
  }>;
};

function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  const resolved = path.resolve(cwd, candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isMainModule({
  currentFile,
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  wrapperEntryPairs = [],
}: IsMainModuleOptions): boolean {
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
  if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) {
    return true;
  }

  // Optional wrapper->entry mapping for wrapper launchers that import the real entry.
  if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
    const currentBase = path.basename(normalizedCurrent);
    const argvBase = path.basename(normalizedArgv1);
    const matched = wrapperEntryPairs.some(
      ({ wrapperBasename, entryBasename }) =>
        currentBase === entryBasename && argvBase === wrapperBasename,
    );
    if (matched) {
      return true;
    }
  }

  // Fallback: basename match (relative paths, symlinked bins).
  if (
    normalizedCurrent &&
    normalizedArgv1 &&
    path.basename(normalizedCurrent) === path.basename(normalizedArgv1)
  ) {
    return true;
  }

  return false;
}
