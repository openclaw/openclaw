import { readFileSync, statSync } from "node:fs";
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
    for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
      const token = match[1] ?? "";
      const relMatch = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i);
      const relative = relMatch?.[1]?.trim();
      if (!relative) {
        continue;
      }
      const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
      const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
      if (isFilePath(candidate)) {
        candidates.push(candidate);
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

  const wrapperDir = path.dirname(wrapperPath);
  const packageDirs = [
    path.resolve(wrapperDir, "..", packageName),
    path.resolve(wrapperDir, "node_modules", packageName),
  ];

  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFilePath(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const entryRel = resolveBinEntry(packageName, packageJson.bin);
      if (!entryRel) {
        continue;
      }
      const entryPath = path.resolve(packageDir, entryRel);
      if (isFilePath(entryPath)) {
        return entryPath;
      }
    } catch {
      // Ignore malformed package metadata.
    }
  }

  return null;
}

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

export function resolveWindowsSpawnProgram(
  params: ResolveWindowsSpawnProgramParams,
): WindowsSpawnProgram {
  const candidate = resolveWindowsSpawnProgramCandidate(params);
  return applyWindowsSpawnProgramPolicy({
    candidate,
    allowShellFallback: params.allowShellFallback,
  });
}

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
