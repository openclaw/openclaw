import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GatewayProgramArgs = {
  programArguments: string[];
  workingDirectory?: string;
};

type GatewayRuntimePreference = "auto" | "node" | "bun";

function isNodeRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe";
}

function isBunRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

/**
 * Detect if a path is inside a pnpm global store (version-specific directory).
 * These paths break after pnpm updates because the version hash changes.
 */
function isPnpmGlobalStorePath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll("\\", "/");
  // Match patterns like:
  // - ~/.local/share/pnpm/5/.pnpm/openclaw@X.Y.Z.../
  // - /home/user/.local/share/pnpm/.../.pnpm/...
  return (
    normalized.includes("/.pnpm/") &&
    (normalized.includes("/.local/share/pnpm/") || normalized.includes("/pnpm/5/"))
  );
}

/**
 * Try to find the CLI wrapper script that pnpm creates for global installs.
 * The wrapper is stable across updates (pnpm regenerates it with new paths).
 */
async function resolvePnpmGlobalWrapperPath(cliName: string): Promise<string | null> {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, "AppData", "Local", "pnpm", `${cliName}.cmd`),
          path.join(home, "AppData", "Local", "pnpm", `${cliName}.ps1`),
        ]
      : [
          path.join(home, ".local", "bin", cliName),
          path.join(home, ".local", "share", "pnpm", cliName),
          `/usr/local/bin/${cliName}`,
        ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve CLI entrypoint path");
  }

  const normalized = path.resolve(argv1);
  const resolvedPath = await resolveRealpathSafe(normalized);

  // For pnpm global installs, prefer the wrapper script over the versioned store path.
  // The wrapper is stable across updates (pnpm regenerates it automatically),
  // while the store path contains version-specific directories that break after updates.
  if (isPnpmGlobalStorePath(resolvedPath)) {
    // Extract CLI name from the path (e.g., "openclaw" from ".../openclaw/openclaw.mjs")
    // Split on both / and \ to handle mixed separators (common in pnpm paths on Windows)
    const pathParts = resolvedPath.split(/[/\\]/);
    const nodeModulesIdx = pathParts.lastIndexOf("node_modules");
    const cliName =
      nodeModulesIdx >= 0 && nodeModulesIdx < pathParts.length - 1
        ? pathParts[nodeModulesIdx + 1]
        : "openclaw";

    const wrapperPath = await resolvePnpmGlobalWrapperPath(cliName);
    if (wrapperPath) {
      return wrapperPath;
    }
    // Fall through to existing logic if wrapper not found
  }

  const looksLikeDist = /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(resolvedPath);
  if (looksLikeDist) {
    await fs.access(resolvedPath);
    // Prefer the original (possibly symlinked) path over the resolved realpath.
    // This keeps LaunchAgent/systemd paths stable across package version updates,
    // since symlinks like node_modules/openclaw -> .pnpm/openclaw@X.Y.Z/...
    // are automatically updated by pnpm, while the resolved path contains
    // version-specific directories that break after updates.
    const normalizedLooksLikeDist = /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(normalized);
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
    throw new Error("Dev mode requires running from repo (src/index.ts)");
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
  const { execFileSync } = await import("node:child_process");
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
    throw new Error("Node not found in PATH. Install Node 22+.");
  }
}

async function resolveCliProgramArguments(params: {
  args: string[];
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
}): Promise<GatewayProgramArgs> {
  const execPath = process.execPath;
  const runtime = params.runtime ?? "auto";

  if (runtime === "node") {
    const nodePath =
      params.nodePath ?? (isNodeRuntime(execPath) ? execPath : await resolveNodePath());
    const cliEntrypointPath = await resolveCliEntrypointPathForService();
    return {
      programArguments: [nodePath, cliEntrypointPath, ...params.args],
    };
  }

  if (runtime === "bun") {
    if (params.dev) {
      const repoRoot = resolveRepoRootForDev();
      const devCliPath = path.join(repoRoot, "src", "index.ts");
      await fs.access(devCliPath);
      const bunPath = isBunRuntime(execPath) ? execPath : await resolveBunPath();
      return {
        programArguments: [bunPath, devCliPath, ...params.args],
        workingDirectory: repoRoot,
      };
    }

    const bunPath = isBunRuntime(execPath) ? execPath : await resolveBunPath();
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
  const devCliPath = path.join(repoRoot, "src", "index.ts");
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
}): Promise<GatewayProgramArgs> {
  const gatewayArgs = ["gateway", "--port", String(params.port)];
  return resolveCliProgramArguments({
    args: gatewayArgs,
    dev: params.dev,
    runtime: params.runtime,
    nodePath: params.nodePath,
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
  });
}
