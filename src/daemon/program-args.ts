import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";
import {
  buildGatewayDistEntrypointCandidates,
  findFirstAccessibleGatewayEntrypoint,
  isGatewayDistEntrypointPath,
} from "./gateway-entrypoint.js";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";

type GatewayProgramArgs = {
  programArguments: string[];
  workingDirectory?: string;
};

type GatewayRuntimePreference = "auto" | "node" | "bun";

export const OPENCLAW_WRAPPER_ENV_KEY = "OPENCLAW_WRAPPER";
export const OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY = "OPENCLAW_DAEMON_RUNTIME_PATH";

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve CLI entrypoint path");
  }

  const normalized = path.resolve(argv1);
  const resolvedPath = await resolveRealpathSafe(normalized);
  const looksLikeDist = isGatewayDistEntrypointPath(resolvedPath);
  if (looksLikeDist) {
    const preferredDistEntrypoint = await findFirstAccessibleGatewayEntrypoint(
      buildGatewayDistEntrypointCandidates(normalized, resolvedPath),
      async (candidate) => {
        try {
          await fs.access(candidate);
          return true;
        } catch {
          return false;
        }
      },
    );
    if (preferredDistEntrypoint) {
      return preferredDistEntrypoint;
    }
    // Prefer the original (possibly symlinked) path over the resolved realpath.
    // This keeps LaunchAgent/systemd paths stable across package version updates,
    // since symlinks like node_modules/openclaw -> .pnpm/openclaw@X.Y.Z/...
    // are automatically updated by pnpm, while the resolved path contains
    // version-specific directories that break after updates.
    const normalizedLooksLikeDist = isGatewayDistEntrypointPath(normalized);
    if (normalizedLooksLikeDist && normalized !== resolvedPath) {
      try {
        await fs.access(normalized);
        return normalized;
      } catch {
        // Fall through to return resolvedPath
      }
    }
    return resolvedPath;
  }

  const distCandidates = buildDistCandidates(resolvedPath, normalized);

  for (const candidate of distCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }

  throw new Error(
    `Cannot find built CLI at ${distCandidates.join(" or ")}. Run "pnpm build" first, or use dev mode.`,
  );
}

async function resolveRealpathSafe(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return inputPath;
  }
}

function buildDistCandidates(...inputs: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const inputPath of inputs) {
    if (!inputPath) {
      continue;
    }
    const baseDir = path.dirname(inputPath);
    appendDistCandidates(candidates, seen, path.resolve(baseDir, ".."));
    appendDistCandidates(candidates, seen, baseDir);
    appendNodeModulesBinCandidates(candidates, seen, inputPath);
  }

  return candidates;
}

function appendDistCandidates(candidates: string[], seen: Set<string>, baseDir: string): void {
  const distDir = path.resolve(baseDir, "dist");
  const distEntries = [
    path.join(distDir, "index.js"),
    path.join(distDir, "index.mjs"),
    path.join(distDir, "entry.js"),
    path.join(distDir, "entry.mjs"),
  ];
  for (const entry of distEntries) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    candidates.push(entry);
  }
}

function appendNodeModulesBinCandidates(
  candidates: string[],
  seen: Set<string>,
  inputPath: string,
): void {
  const parts = inputPath.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) {
    return;
  }
  if (parts[binIndex - 1] !== "node_modules") {
    return;
  }
  const binName = path.basename(inputPath);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  const packageRoot = path.join(nodeModulesDir, binName);
  appendDistCandidates(candidates, seen, packageRoot);
}

function resolveRepoRootForDev(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve repo root");
  }
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex === -1) {
    throw new Error("Dev mode requires running from repo (src/entry.ts)");
  }
  return parts.slice(0, srcIndex).join(path.sep);
}

async function resolveBunPath(): Promise<string> {
  const bunPath = await resolveBinaryPath("bun");
  return bunPath;
}

async function resolveNodePath(): Promise<string> {
  const nodePath = await resolveBinaryPath("node");
  return nodePath;
}

async function resolveBinaryPath(binary: string): Promise<string> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(cmd, [binary], { encoding: "utf8" }).trim();
    const resolved = output.split(/\r?\n/)[0]?.trim();
    if (!resolved) {
      throw new Error("empty");
    }
    await fs.access(resolved);
    return resolved;
  } catch {
    if (binary === "bun") {
      throw new Error("Bun not found in PATH. Install bun: https://bun.sh");
    }
    throw new Error(
      "Node not found in PATH. Install Node 24 (recommended) or Node 22 LTS (22.19+).",
    );
  }
}

export async function resolveOpenClawWrapperPath(
  inputPath: string | undefined,
): Promise<string | undefined> {
  const trimmed = inputPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    await fs.access(resolved, fsConstants.X_OK);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `${OPENCLAW_WRAPPER_ENV_KEY} must point to an executable file: ${resolved}${detail}`,
      { cause: error },
    );
  }
  return resolved;
}

function pathModuleFor(inputPath: string) {
  return /^[A-Za-z]:[\\/]/.test(inputPath) || inputPath.includes("\\") ? path.win32 : path.posix;
}

function normalizeAbsoluteRuntimePath(inputPath: string): string {
  const modulePath = pathModuleFor(inputPath);
  if (!modulePath.isAbsolute(inputPath)) {
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} must be an absolute executable path: ${inputPath}`,
    );
  }
  return modulePath.normalize(inputPath);
}

export function resolveOpenClawRuntimePathKind(runtimePath: string): "node" | "bun" | undefined {
  if (isNodeRuntime(runtimePath)) {
    return "node";
  }
  if (isBunRuntime(runtimePath)) {
    return "bun";
  }
  return undefined;
}

function validateRuntimePathKind(
  runtimePath: string,
  runtime: GatewayRuntimePreference,
): "node" | "bun" {
  const runtimeKind = resolveOpenClawRuntimePathKind(runtimePath);
  if (!runtimeKind) {
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} must point to a node or bun executable: ${runtimePath}`,
    );
  }
  if (runtime !== "auto" && runtimeKind !== runtime) {
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} must point to a ${runtime} executable when --runtime ${runtime} is used: ${runtimePath}`,
    );
  }
  return runtimeKind;
}

function validateNodeRuntimePathVersion(runtimePath: string): void {
  let versionText = "";
  try {
    versionText = execFileSync(runtimePath, ["-p", "process.versions.node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} could not run node version check for ${runtimePath}: ${detail}`,
      { cause: error },
    );
  }

  if (!isSupportedNodeVersion(versionText)) {
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} points to unsupported Node ${versionText || "unknown"} at ${runtimePath}; OpenClaw requires Node 22.16 or newer.`,
    );
  }
}

export async function resolveOpenClawRuntimePath(
  inputPath: string | undefined,
  runtime: GatewayRuntimePreference,
): Promise<string | undefined> {
  const trimmed = inputPath?.trim();
  if (!trimmed) {
    return undefined;
  }

  const resolved = normalizeAbsoluteRuntimePath(trimmed);
  const runtimeKind = validateRuntimePathKind(resolved, runtime);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    await fs.access(resolved, fsConstants.X_OK);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `${OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY} must point to an executable file: ${resolved}${detail}`,
      { cause: error },
    );
  }

  if (runtimeKind === "node") {
    validateNodeRuntimePathVersion(resolved);
  }

  return resolved;
}

async function resolveCliProgramArguments(params: {
  args: string[];
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
  runtimePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const wrapperPath = await resolveOpenClawWrapperPath(params.wrapperPath);
  if (wrapperPath) {
    return { programArguments: [wrapperPath, ...params.args] };
  }

  const execPath = process.execPath;
  const runtime = params.runtime ?? "auto";
  const explicitRuntimePath = await resolveOpenClawRuntimePath(params.runtimePath, runtime);
  const effectiveRuntime =
    runtime === "auto" && explicitRuntimePath
      ? resolveOpenClawRuntimePathKind(explicitRuntimePath)
      : runtime;

  if (effectiveRuntime === "node") {
    const nodePath =
      explicitRuntimePath ??
      params.nodePath ??
      (isNodeRuntime(execPath) ? execPath : await resolveNodePath());
    const cliEntrypointPath = await resolveCliEntrypointPathForService();
    return {
      programArguments: [nodePath, cliEntrypointPath, ...params.args],
    };
  }

  if (effectiveRuntime === "bun") {
    if (params.dev) {
      const repoRoot = resolveRepoRootForDev();
      const devCliPath = path.join(repoRoot, "src", "entry.ts");
      await fs.access(devCliPath);
      const bunPath =
        explicitRuntimePath ?? (isBunRuntime(execPath) ? execPath : await resolveBunPath());
      return {
        programArguments: [bunPath, devCliPath, ...params.args],
        workingDirectory: repoRoot,
      };
    }

    const bunPath =
      explicitRuntimePath ?? (isBunRuntime(execPath) ? execPath : await resolveBunPath());
    const cliEntrypointPath = await resolveCliEntrypointPathForService();
    return {
      programArguments: [bunPath, cliEntrypointPath, ...params.args],
    };
  }

  if (!params.dev) {
    try {
      const cliEntrypointPath = await resolveCliEntrypointPathForService();
      return {
        programArguments: [execPath, cliEntrypointPath, ...params.args],
      };
    } catch (error) {
      // If running under bun or another runtime that can execute TS directly
      if (!isNodeRuntime(execPath)) {
        return { programArguments: [execPath, ...params.args] };
      }
      throw error;
    }
  }

  // Dev mode: use bun to run TypeScript directly
  const repoRoot = resolveRepoRootForDev();
  const devCliPath = path.join(repoRoot, "src", "entry.ts");
  await fs.access(devCliPath);

  // If already running under bun, use current execPath
  if (isBunRuntime(execPath)) {
    return {
      programArguments: [execPath, devCliPath, ...params.args],
      workingDirectory: repoRoot,
    };
  }

  // Otherwise resolve bun from PATH
  const bunPath = await resolveBunPath();
  return {
    programArguments: [bunPath, devCliPath, ...params.args],
    workingDirectory: repoRoot,
  };
}

export async function resolveGatewayProgramArguments(params: {
  port: number;
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
  runtimePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const gatewayArgs = ["gateway", "--port", String(params.port)];
  return resolveCliProgramArguments({
    args: gatewayArgs,
    dev: params.dev,
    runtime: params.runtime,
    nodePath: params.nodePath,
    runtimePath: params.runtimePath,
    wrapperPath: params.wrapperPath,
  });
}

export async function resolveNodeProgramArguments(params: {
  host: string;
  port: number;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
  runtimePath?: string;
}): Promise<GatewayProgramArgs> {
  const args = ["node", "run", "--host", params.host, "--port", String(params.port)];
  if (params.tls || params.tlsFingerprint) {
    args.push("--tls");
  }
  if (params.tlsFingerprint) {
    args.push("--tls-fingerprint", params.tlsFingerprint);
  }
  if (params.nodeId) {
    args.push("--node-id", params.nodeId);
  }
  if (params.displayName) {
    args.push("--display-name", params.displayName);
  }
  return resolveCliProgramArguments({
    args,
    dev: params.dev,
    runtime: params.runtime,
    nodePath: params.nodePath,
    runtimePath: params.runtimePath,
  });
}
