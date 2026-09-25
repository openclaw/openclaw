// Reads and applies global dotenv files without loading config or logging.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRegularFile, readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { parse as parseDotEnv } from "dotenv";
import { resolveConfigDir } from "./config-dir.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { normalizeEnvVarKey } from "./host-env-security.js";

/** Maximum bytes to read from any dotenv file. */
const MAX_DOTENV_FILE_BYTES = 1024 * 1024;

type DotEnvWarning = (message: string, meta?: Record<string, unknown>) => void;

type DotEnvEntry = {
  key: string;
  value: string;
};

export type LoadedDotEnvFile = {
  filePath: string;
  entries: DotEnvEntry[];
};

export type GlobalRuntimeDotEnvOptions = {
  env?: NodeJS.ProcessEnv;
  additionalEnvPaths?: string[];
  entryFilter?: (key: string, value: string) => boolean;
  /** Keys whose service-managed inherited values may be replaced by trusted dotenv files. */
  overrideKeys?: Iterable<string>;
  quiet?: boolean;
  stateEnvPath?: string;
  onWarning?: DotEnvWarning;
};

export type ReadDotEnvFileOptions = {
  entryFilter?: (key: string, value: string) => boolean;
  filePath: string;
  quiet?: boolean;
  onWarning?: DotEnvWarning;
};

function reportDotEnvReadError(params: ReadDotEnvFileOptions, error: unknown): void {
  if (params.quiet) {
    return;
  }
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (code !== "ENOENT") {
    params.onWarning?.(`Failed to read ${params.filePath}: ${String(error)}`, { error });
  }
  // Surface oversized files so operators know a configured file was skipped.
  if (error instanceof Error && error.message?.startsWith("File exceeds")) {
    params.onWarning?.(
      `skipping oversized .env file (max ${MAX_DOTENV_FILE_BYTES} bytes): ${params.filePath}`,
    );
  }
}

function parseDotEnvFile(params: ReadDotEnvFileOptions, content: Buffer): LoadedDotEnvFile {
  const entries: DotEnvEntry[] = [];
  for (const [rawKey, value] of Object.entries(parseDotEnv(content))) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (key && (params.entryFilter?.(key, value) ?? true)) {
      entries.push({ key, value });
    }
  }
  return { filePath: params.filePath, entries };
}

export function readDotEnvFileCore(params: ReadDotEnvFileOptions): LoadedDotEnvFile | null {
  let content: Buffer;
  try {
    // Resolve symlinks so a symlinked .env file works while the bounded
    // read still rejects oversized targets.
    const resolved = fs.realpathSync(params.filePath);
    const { buffer } = readRegularFileSync({
      filePath: resolved,
      maxBytes: MAX_DOTENV_FILE_BYTES,
    });
    content = buffer;
  } catch (error) {
    reportDotEnvReadError(params, error);
    return null;
  }

  return parseDotEnvFile(params, content);
}

export async function readDotEnvFileAsyncCore(
  params: ReadDotEnvFileOptions,
): Promise<LoadedDotEnvFile | null> {
  let content: Buffer;
  try {
    const resolved = await fs.promises.realpath(params.filePath);
    const { buffer } = await readRegularFile({
      filePath: resolved,
      maxBytes: MAX_DOTENV_FILE_BYTES,
    });
    content = buffer;
  } catch (error) {
    reportDotEnvReadError(params, error);
    return null;
  }
  return parseDotEnvFile(params, content);
}

function loadParsedDotEnvFiles(
  files: LoadedDotEnvFile[],
  env: NodeJS.ProcessEnv,
  overrideKeys?: Iterable<string>,
  onWarning?: DotEnvWarning,
): Map<string, string[]> {
  const preExistingKeys = new Set(Object.keys(env));
  const canonicalizeKey = (key: string): string | null =>
    normalizeEnvVarKey(key, { portable: true })?.toUpperCase() ?? null;
  const normalizedOverrideKeys = new Set(
    [...(overrideKeys ?? [])].flatMap((key) => {
      const normalized = canonicalizeKey(key);
      return normalized ? [normalized] : [];
    }),
  );
  const conflicts = new Map<string, { keptPath: string; ignoredPath: string; keys: Set<string> }>();
  const firstSeen = new Map<string, { value: string; filePath: string }>();
  const appliedKeysByFile = new Map<string, string[]>();

  for (const file of files) {
    for (const { key, value } of file.entries) {
      const canonicalKey = canonicalizeKey(key);
      const mayOverride = canonicalKey !== null && normalizedOverrideKeys.has(canonicalKey);
      const precedenceKey = mayOverride && canonicalKey ? canonicalKey : key;
      if (preExistingKeys.has(key) && !mayOverride) {
        continue;
      }
      const previous = firstSeen.get(precedenceKey);
      if (previous) {
        if (previous.value !== value) {
          // First file wins for deterministic startup; conflicts are logged once
          // after parsing so sensitive values are not printed.
          const conflictKey = `${previous.filePath}\u0000${file.filePath}`;
          const existing = conflicts.get(conflictKey);
          if (existing) {
            existing.keys.add(key);
          } else {
            conflicts.set(conflictKey, {
              keptPath: previous.filePath,
              ignoredPath: file.filePath,
              keys: new Set([key]),
            });
          }
        }
        continue;
      }
      firstSeen.set(precedenceKey, { value, filePath: file.filePath });
      if (env[key] === undefined || mayOverride) {
        if (mayOverride) {
          // Service ownership is case-insensitive. Refresh every inherited alias so Linux cannot
          // retain a stale uppercase value beside a newly parsed lowercase dotenv key.
          for (const inheritedKey of preExistingKeys) {
            if (canonicalizeKey(inheritedKey) === canonicalKey) {
              env[inheritedKey] = value;
            }
          }
        }
        env[key] = value;
        const appliedKeys = appliedKeysByFile.get(file.filePath);
        if (appliedKeys) {
          appliedKeys.push(key);
        } else {
          appliedKeysByFile.set(file.filePath, [key]);
        }
      }
    }
  }

  for (const conflict of conflicts.values()) {
    const keys = [...conflict.keys].toSorted();
    if (keys.length === 0) {
      continue;
    }
    onWarning?.(
      `Conflicting values in ${conflict.keptPath} and ${conflict.ignoredPath} for ${keys.join(", ")}; keeping ${conflict.keptPath}.`,
      { keptPath: conflict.keptPath, ignoredPath: conflict.ignoredPath, keys },
    );
  }
  return appliedKeysByFile;
}

function resolveGlobalDotEnvPaths(opts: GlobalRuntimeDotEnvOptions, env: NodeJS.ProcessEnv) {
  const stateEnvPath = opts.stateEnvPath ?? path.join(resolveConfigDir(env), ".env");
  const globalEnvPaths = [...new Set([stateEnvPath, ...(opts.additionalEnvPaths ?? [])])];
  const home = resolveRequiredHomeDir(env, os.homedir);
  const defaultStateEnvPath = path.join(home, ".openclaw", ".env");
  const hasExplicitNonDefaultStateDir =
    env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  return {
    globalEnvPaths,
    gatewayEnvPath: hasExplicitNonDefaultStateDir
      ? undefined
      : path.join(home, ".config", "openclaw", "gateway.env"),
  };
}

function applyGlobalDotEnvFiles(
  globalEnvs: (LoadedDotEnvFile | null)[],
  gatewayEnv: LoadedDotEnvFile | null,
  env: NodeJS.ProcessEnv,
  overrideKeys?: Iterable<string>,
  onWarning?: DotEnvWarning,
) {
  const parsed = [...globalEnvs, gatewayEnv].filter(
    (file): file is LoadedDotEnvFile => file !== null,
  );
  const appliedKeysByFile = loadParsedDotEnvFiles(parsed, env, overrideKeys, onWarning);
  return {
    dotenvPresentKeys: [...new Set(parsed.flatMap((file) => file.entries.map(({ key }) => key)))],
    stateEnvAppliedKeys: globalEnvs.flatMap((file) =>
      file ? (appliedKeysByFile.get(file.filePath) ?? []) : [],
    ),
    gatewayEnvAppliedKeys: gatewayEnv ? (appliedKeysByFile.get(gatewayEnv.filePath) ?? []) : [],
  };
}

/** Load global runtime dotenv files with first-wins precedence, defaulting to `process.env`. */
export function loadGlobalRuntimeDotEnvFilesCore(opts: GlobalRuntimeDotEnvOptions = {}) {
  const env = opts.env ?? process.env;
  const { globalEnvPaths, gatewayEnvPath } = resolveGlobalDotEnvPaths(opts, env);
  const readOptions = {
    entryFilter: opts.entryFilter,
    quiet: opts.quiet ?? true,
    onWarning: opts.onWarning,
  };
  const globalEnvs = globalEnvPaths.map((filePath) =>
    readDotEnvFileCore({ ...readOptions, filePath }),
  );
  const gatewayEnv = gatewayEnvPath
    ? readDotEnvFileCore({ ...readOptions, filePath: gatewayEnvPath })
    : null;
  return applyGlobalDotEnvFiles(globalEnvs, gatewayEnv, env, opts.overrideKeys, opts.onWarning);
}

/** Read global runtime dotenv files asynchronously into a caller-owned environment. */
export async function loadGlobalRuntimeDotEnvFilesAsyncCore(
  opts: GlobalRuntimeDotEnvOptions & { env: NodeJS.ProcessEnv },
) {
  const { env } = opts;
  const { globalEnvPaths, gatewayEnvPath } = resolveGlobalDotEnvPaths(opts, env);
  const readOptions = {
    entryFilter: opts.entryFilter,
    quiet: opts.quiet ?? true,
    onWarning: opts.onWarning,
  };
  const globalEnvs: (LoadedDotEnvFile | null)[] = [];
  for (const filePath of globalEnvPaths) {
    globalEnvs.push(await readDotEnvFileAsyncCore({ ...readOptions, filePath }));
  }
  const gatewayEnv = gatewayEnvPath
    ? await readDotEnvFileAsyncCore({ ...readOptions, filePath: gatewayEnvPath })
    : null;
  return applyGlobalDotEnvFiles(globalEnvs, gatewayEnv, env, opts.overrideKeys, opts.onWarning);
}
