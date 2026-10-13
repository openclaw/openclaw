/** Read one environment value using the same Windows key precedence as child_process. */
export function resolveEnvironmentValue(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!env) {
    return undefined;
  }
  if (platform !== "win32") {
    return env[name] ?? (name === "PATH" ? env.Path : undefined);
  }
  const normalizedName = name.toUpperCase();
  const key = Object.keys(env)
    .toSorted()
    .find((candidate) => candidate.toUpperCase() === normalizedName);
  return key === undefined ? undefined : env[key];
}

/** Merge child environments while preserving Node's platform-specific key semantics. */
export function mergeProcessEnv(
  sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const mergedKeys = new Map<string, string>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const keys = Object.keys(source);
    // Node keeps the lexicographically first case-insensitive duplicate from each
    // Windows env object. Later source objects still own override precedence.
    const sourceKeys = new Set<string>();
    for (const key of platform === "win32" ? keys.toSorted() : keys) {
      const normalizedKey = platform === "win32" ? key.toUpperCase() : undefined;
      if (normalizedKey !== undefined) {
        if (sourceKeys.has(normalizedKey)) {
          continue;
        }
        sourceKeys.add(normalizedKey);
        const previousKey = mergedKeys.get(normalizedKey);
        if (previousKey !== undefined) {
          delete merged[previousKey];
        }
        mergedKeys.delete(normalizedKey);
      }
      const value = source[key];
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
        // Only own keys participate in Windows override matching.
        if (normalizedKey !== undefined && Object.hasOwn(merged, key)) {
          mergedKeys.set(normalizedKey, key);
        }
      }
    }
  }

  return merged;
}

// Native diagnostics need executable/account/temp routing, not the application's environment.
// Windows names are uppercase here; selection preserves the winning source spelling below.
const DIAGNOSTIC_PROCESS_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
  // Windows bootstrap, DLL resolution, and native profile directories.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  // PowerShell reads this caller-selected module cache location during startup.
  "PSMODULEANALYSISCACHEPATH",
]);

/** Project only native port/process diagnostic context; never mutate the parent environment. */
export function resolveDiagnosticProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // Merge first so an undefined lexically-first Windows duplicate still masks later spellings.
  return Object.fromEntries(
    Object.entries(mergeProcessEnv([env], platform)).filter(([key]) =>
      DIAGNOSTIC_PROCESS_ENV_KEYS.has(platform === "win32" ? key.toUpperCase() : key),
    ),
  );
}
