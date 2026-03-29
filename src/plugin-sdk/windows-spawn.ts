import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type WindowsSpawnResolution =
  | "direct"
  | "node-entrypoint"
  | "exe-entrypoint"
  | "shell-fallback";

export type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;
export type WindowsSpawnProgramCandidate = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
  windowsHide?: boolean;
};

export type WindowsSpawnProgram = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

export type WindowsSpawnInvocation = {
  command: string;
  argv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

export type ResolveWindowsSpawnProgramParams = {
  command: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  packageName?: string;
  allowShellFallback?: boolean;
};
export type ResolveWindowsSpawnProgramCandidateParams = Omit<
  ResolveWindowsSpawnProgramParams,
  "allowShellFallback"
>;

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve a Windows command name through PATH and PATHEXT so wrapper inspection sees the real file. */
export function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasExtension = path.extname(command).length > 0;
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const pathExt = hasExtension
    ? [""]
    : pathExtRaw
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  for (const dir of pathEntries) {
    for (const ext of pathExt) {
      for (const candidateExt of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
        const candidate = path.join(dir, `${command}${candidateExt}`);
        if (isFilePath(candidate)) {
          return candidate;
        }
      }
    }
  }

  return command;
}

function resolveEntrypointFromCmdShim(wrapperPath: string): string | null {
  if (!isFilePath(wrapperPath)) {
    return null;
  }

  try {
    const content = readFileSync(wrapperPath, "utf8");
    const candidates: string[] = [];
    const pushCandidate = (relativeRaw: string) => {
      const relative = relativeRaw.trim();
      if (!relative || relative.includes("%")) {
        return;
      }
      const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
      const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
      if (isFilePath(candidate)) {
        candidates.push(candidate);
      }
    };

    for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
      const token = match[1] ?? "";
      const relMatch = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i);
      if (relMatch?.[1]) {
        pushCandidate(relMatch[1]);
      }
    }

    for (const match of content.matchAll(/%~?dp0%?\s*[\\/]([^\r\n"%*]+\.(?:exe|c?js|mjs))/gi)) {
      if (match[1]) {
        pushCandidate(match[1]);
      }
    }

    const nonNode = candidates.find((candidate) => {
      const base = path.basename(candidate).toLowerCase();
      return base !== "node.exe" && base !== "node";
    });
    return nonNode ?? null;
  } catch {
    return null;
  }
}

function resolveBinEntry(
  packageName: string | undefined,
  binField: string | Record<string, string> | undefined,
): string | null {
  if (typeof binField === "string") {
    const trimmed = binField.trim();
    return trimmed || null;
  }
  if (!binField || typeof binField !== "object") {
    return null;
  }

  if (packageName) {
    const preferred = binField[packageName];
    if (typeof preferred === "string" && preferred.trim()) {
      return preferred.trim();
    }
    // For scoped packages like `@scope/pkg`, also try the unscoped `pkg` name.
    const unscopedName = packageName.includes("/") ? packageName.split("/").pop() : undefined;
    if (unscopedName) {
      const unscopedEntry = binField[unscopedName];
      if (typeof unscopedEntry === "string" && unscopedEntry.trim()) {
        return unscopedEntry.trim();
      }
    }
  }

  for (const value of Object.values(binField)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveEntrypointFromPackageJson(
  wrapperPath: string,
  packageName?: string,
): string | null {
  if (!packageName) {
    return null;
  }

  // Don't gate on basename matching — renamed .cmd shims (e.g. qmd-beta.cmd
  // wrapping the qmd package) should still fall through to the package.json
  // lookup so we can resolve the real entrypoint.

  const tryResolveFromPackageJson = (packageJsonPath: string): string | null => {
    if (!isFilePath(packageJsonPath)) {
      return null;
    }
    try {
      const packageDir = path.dirname(packageJsonPath);
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const entryRel = resolveBinEntry(packageName, packageJson.bin);
      if (!entryRel) {
        return null;
      }
      const entryPath = path.resolve(packageDir, entryRel);
      return isFilePath(entryPath) ? entryPath : null;
    } catch {
      return null;
    }
  };

  const wrapperDir = path.dirname(wrapperPath);
  const linkedPackageDir = path.resolve(wrapperDir, "..", packageName);
  const linkedRealPath = fsRealpathSafe(linkedPackageDir);
  if (linkedRealPath) {
    const entryPath = tryResolveFromPackageJson(path.join(linkedRealPath, "package.json"));
    if (entryPath) {
      return entryPath;
    }
  }
  const packageDirs = [
    path.resolve(wrapperDir, "..", packageName),
    path.resolve(wrapperDir, "node_modules", packageName),
  ];

  for (const packageDir of packageDirs) {
    const entryPath = tryResolveFromPackageJson(path.join(packageDir, "package.json"));
    if (entryPath) {
      return entryPath;
    }
  }

  try {
    const requireFromWrapper = createRequire(
      path.join(wrapperDir, "__openclaw_windows_spawn__.js"),
    );
    const resolvedPackageJson = requireFromWrapper.resolve(`${packageName}/package.json`);
    const entryPath = tryResolveFromPackageJson(resolvedPackageJson);
    if (entryPath) {
      return entryPath;
    }
  } catch {
    // ignore package resolution failures
  }

  const pnpmStoreDir = path.resolve(wrapperDir, "..", ".pnpm");
  try {
    for (const entry of readdirSync(pnpmStoreDir)) {
      const entryPackageJson = path.join(
        pnpmStoreDir,
        entry,
        "node_modules",
        packageName,
        "package.json",
      );
      const entryPath = tryResolveFromPackageJson(entryPackageJson);
      if (entryPath) {
        return entryPath;
      }
    }
  } catch {
    // ignore .pnpm scan failures
  }

  return null;
}

function fsRealpathSafe(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/** Resolve the safest direct spawn candidate for Windows wrappers, scripts, and binaries. */
export function resolveWindowsSpawnProgramCandidate(
  params: ResolveWindowsSpawnProgramCandidateParams,
): WindowsSpawnProgramCandidate {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const execPath = params.execPath ?? process.execPath;

  if (platform !== "win32") {
    return {
      command: params.command,
      leadingArgv: [],
      resolution: "direct",
    };
  }

  const resolvedCommand = resolveWindowsExecutablePath(params.command, env);
  const ext = path.extname(resolvedCommand).toLowerCase();
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return {
      command: execPath,
      leadingArgv: [resolvedCommand],
      resolution: "node-entrypoint",
      windowsHide: true,
    };
  }

  if (ext === ".cmd" || ext === ".bat") {
    const entrypoint =
      resolveEntrypointFromCmdShim(resolvedCommand) ??
      resolveEntrypointFromPackageJson(resolvedCommand, params.packageName);
    if (entrypoint) {
      const entryExt = path.extname(entrypoint).toLowerCase();
      if (entryExt === ".exe") {
        return {
          command: entrypoint,
          leadingArgv: [],
          resolution: "exe-entrypoint",
          windowsHide: true,
        };
      }
      return {
        command: execPath,
        leadingArgv: [entrypoint],
        resolution: "node-entrypoint",
        windowsHide: true,
      };
    }

    return {
      command: resolvedCommand,
      leadingArgv: [],
      resolution: "unresolved-wrapper",
    };
  }

  return {
    command: resolvedCommand,
    leadingArgv: [],
    resolution: "direct",
  };
}

/** Apply shell-fallback policy when Windows wrapper resolution could not find a direct entrypoint. */
export function applyWindowsSpawnProgramPolicy(params: {
  candidate: WindowsSpawnProgramCandidate;
  allowShellFallback?: boolean;
}): WindowsSpawnProgram {
  if (params.candidate.resolution !== "unresolved-wrapper") {
    return {
      command: params.candidate.command,
      leadingArgv: params.candidate.leadingArgv,
      resolution: params.candidate.resolution,
      windowsHide: params.candidate.windowsHide,
    };
  }
  if (params.allowShellFallback !== false) {
    return {
      command: params.candidate.command,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    };
  }
  throw new Error(
    `${path.basename(params.candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`,
  );
}

/** Resolve the final Windows spawn program after candidate discovery and fallback policy. */
export function resolveWindowsSpawnProgram(
  params: ResolveWindowsSpawnProgramParams,
): WindowsSpawnProgram {
  const candidate = resolveWindowsSpawnProgramCandidate(params);
  return applyWindowsSpawnProgramPolicy({
    candidate,
    allowShellFallback: params.allowShellFallback,
  });
}

/** Combine a resolved Windows spawn program with call-site argv for actual process launch. */
export function materializeWindowsSpawnProgram(
  program: WindowsSpawnProgram,
  argv: string[],
): WindowsSpawnInvocation {
  return {
    command: program.command,
    argv: [...program.leadingArgv, ...argv],
    resolution: program.resolution,
    shell: program.shell,
    windowsHide: program.windowsHide,
  };
}
