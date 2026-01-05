import fs from "node:fs/promises";
import path from "node:path";

type GatewayProgramArgs = {
  programArguments: string[];
  workingDirectory?: string;
};

function isNodeRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe";
}

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("Unable to resolve CLI entrypoint path");

  const normalized = path.resolve(argv1);
  const resolvedPath = await resolveRealpathSafe(normalized);
  const looksLikeDist = /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(resolvedPath);
  if (looksLikeDist) {
    await fs.access(resolvedPath);
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
    if (!inputPath) continue;
    const baseDir = path.dirname(inputPath);
    appendDistCandidates(candidates, seen, path.resolve(baseDir, ".."));
    appendDistCandidates(candidates, seen, baseDir);
    appendNodeModulesBinCandidates(candidates, seen, inputPath);
  }

  return candidates;
}

function appendDistCandidates(
  candidates: string[],
  seen: Set<string>,
  baseDir: string,
): void {
  const distDir = path.resolve(baseDir, "dist");
  const distEntries = [
    path.join(distDir, "index.js"),
    path.join(distDir, "index.mjs"),
    path.join(distDir, "entry.js"),
    path.join(distDir, "entry.mjs"),
  ];
  for (const entry of distEntries) {
    if (seen.has(entry)) continue;
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
  if (binIndex <= 0) return;
  if (parts[binIndex - 1] !== "node_modules") return;
  const binName = path.basename(inputPath);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  const packageRoot = path.join(nodeModulesDir, binName);
  appendDistCandidates(candidates, seen, packageRoot);
}

function resolveRepoRootForDev(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("Unable to resolve repo root");
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex === -1) {
    throw new Error("Dev mode requires running from repo (src/index.ts)");
  }
  return parts.slice(0, srcIndex).join(path.sep);
}

async function resolveTsxCliPath(repoRoot: string): Promise<string> {
  const candidate = path.join(
    repoRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  await fs.access(candidate);
  return candidate;
}

export async function resolveGatewayProgramArguments(params: {
  port: number;
  dev?: boolean;
}): Promise<GatewayProgramArgs> {
  const gatewayArgs = ["gateway-daemon", "--port", String(params.port)];
  const nodePath = process.execPath;

  if (!params.dev) {
    try {
      const cliEntrypointPath = await resolveCliEntrypointPathForService();
      return {
        programArguments: [nodePath, cliEntrypointPath, ...gatewayArgs],
      };
    } catch (error) {
      if (!isNodeRuntime(nodePath)) {
        return { programArguments: [nodePath, ...gatewayArgs] };
      }
      throw error;
    }
  }

  const repoRoot = resolveRepoRootForDev();
  const tsxCliPath = await resolveTsxCliPath(repoRoot);
  const devCliPath = path.join(repoRoot, "src", "index.ts");
  await fs.access(devCliPath);
  return {
    programArguments: [nodePath, tsxCliPath, devCliPath, ...gatewayArgs],
    workingDirectory: repoRoot,
  };
}
