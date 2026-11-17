import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nodeRuntimePathEntries } from "../../node-runtime-env.mjs";
import {
  createRuntimeProcessScriptFile,
  createRuntimeProcessScriptFileAsync,
} from "../../runtime-process-scripts.generated.mjs";

// Tooling imports this bootstrap directly in Node before a TypeScript loader is available.

const NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const NODE_RUNTIME_CACHE_MAX_ENTRIES = 16;

const resolvedNodeRuntimeExecutables = new Map<string, string | null>();
const execFileAsync = promisify(execFile);

type NodeRuntimeOptions = { env?: NodeJS.ProcessEnv; requiredFlag?: string };

function buildProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probeEnv: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = env[key];
    if (value) {
      probeEnv[key] = value;
    }
  }
  return probeEnv;
}

function buildNodeExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  const names =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((extension) => `node${extension.toLowerCase()}`)
      : ["node"];
  const candidates = nodeRuntimePathEntries(env.PATH).flatMap((directory) =>
    names.map((name) => path.join(directory, name)),
  );
  if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/node",
      "/opt/homebrew/opt/node/bin/node",
      "/usr/local/bin/node",
      "/usr/local/opt/node/bin/node",
      "/usr/bin/node",
    );
  } else if (process.platform === "linux") {
    candidates.push("/usr/local/bin/node", "/usr/bin/node");
  }
  return [...new Set(candidates)];
}

function prepareNodeRuntimeResolution(options?: NodeRuntimeOptions):
  | { resolved: string | undefined }
  | {
      cacheKey: string;
      requiredFlag: string | undefined;
      candidates: string[];
      env: NodeJS.ProcessEnv;
    } {
  const env = options?.env ?? process.env;
  const requiredFlag = options?.requiredFlag;
  if (
    !process.versions.bun &&
    (!requiredFlag || process.allowedNodeEnvironmentFlags.has(requiredFlag))
  ) {
    return { resolved: process.execPath };
  }

  const cacheKey = [
    process.platform,
    process.versions.bun ?? process.versions.node,
    requiredFlag ?? "",
    env.PATH ?? "",
    env.PATHEXT ?? "",
  ].join("\0");
  const cached = resolvedNodeRuntimeExecutables.get(cacheKey);
  if (cached !== undefined) {
    return { resolved: cached ?? undefined };
  }

  return {
    cacheKey,
    requiredFlag,
    candidates: buildNodeExecutableCandidates(env),
    env: buildProbeEnv(env),
  };
}

function recordNodeRuntimeResolution(cacheKey: string, resolved: string | undefined) {
  resolvedNodeRuntimeExecutables.set(cacheKey, resolved ?? null);
  while (resolvedNodeRuntimeExecutables.size > NODE_RUNTIME_CACHE_MAX_ENTRIES) {
    const oldest = resolvedNodeRuntimeExecutables.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    resolvedNodeRuntimeExecutables.delete(oldest);
  }
  return resolved;
}

/** Synchronous compatibility for CLI tooling and the published process-runtime SDK. */
export function resolveNodeRuntimeExecutable(options?: NodeRuntimeOptions): string | undefined {
  const resolution = prepareNodeRuntimeResolution(options);
  if (!("cacheKey" in resolution)) {
    return resolution.resolved;
  }
  const { cacheKey, requiredFlag, candidates, env } = resolution;

  const script = createRuntimeProcessScriptFile("nodeRuntimeProbe");
  let resolved: string | undefined;
  try {
    for (const candidate of candidates) {
      try {
        const nodePath = execFileSync(candidate, [fileURLToPath(script.url), requiredFlag ?? ""], {
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: NODE_RUNTIME_PROBE_TIMEOUT_MS,
        }).trim();
        if (nodePath) {
          resolved = nodePath;
          break;
        }
      } catch {
        // Missing, non-executable, incompatible, and Bun shim candidates are skipped.
      }
    }
  } finally {
    script.dispose();
  }

  return recordNodeRuntimeResolution(cacheKey, resolved);
}

/** Runtime requests must not create probe files or wait for child exit on the main thread. */
export async function resolveNodeRuntimeExecutableAsync(
  options?: NodeRuntimeOptions,
): Promise<string | undefined> {
  const resolution = prepareNodeRuntimeResolution(options);
  if (!("cacheKey" in resolution)) {
    return resolution.resolved;
  }
  const { cacheKey, requiredFlag, candidates, env } = resolution;
  const script = await createRuntimeProcessScriptFileAsync("nodeRuntimeProbe");
  let resolved: string | undefined;
  try {
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(
          candidate,
          [fileURLToPath(script.url), requiredFlag ?? ""],
          {
            encoding: "utf8",
            env,
            timeout: NODE_RUNTIME_PROBE_TIMEOUT_MS,
          },
        );
        if (stdout.trim()) {
          resolved = stdout.trim();
          break;
        }
      } catch {
        // Missing, non-executable, incompatible, and Bun shim candidates are skipped.
      }
    }
  } finally {
    await script.dispose();
  }
  return recordNodeRuntimeResolution(cacheKey, resolved);
}
