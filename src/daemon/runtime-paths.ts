import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";

const VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

// Matches Homebrew Cellar paths like /opt/homebrew/Cellar/node/25.5.0/bin/node,
// /home/linuxbrew/.linuxbrew/Cellar/node/25.5.0/bin/node, or keg-only installs
// like /opt/homebrew/Cellar/node@22/22.15.0/bin/node. These versioned paths
// break when Homebrew upgrades Node because the old Cellar directory is removed.
// We detect this pattern and resolve to the stable symlink instead.
// Group 1 = prefix (e.g. /opt/homebrew), group 2 = formula name (e.g. "node" or "node@22").
const HOMEBREW_CELLAR_RE = /^(.+)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function isNodeExecPath(execPath: string, platform: NodeJS.Platform): boolean {
  const pathModule = getPathModule(platform);
  const base = pathModule.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe";
}

function normalizeForCompare(input: string, platform: NodeJS.Platform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(input).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function buildSystemNodeCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  }
  if (platform === "linux") {
    return ["/usr/local/bin/node", "/usr/bin/node"];
  }
  if (platform === "win32") {
    const pathModule = getPathModule(platform);
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      pathModule.join(programFiles, "nodejs", "node.exe"),
      pathModule.join(programFilesX86, "nodejs", "node.exe"),
    ];
  }
  return [];
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

async function resolveNodeVersion(
  nodePath: string,
  execFileImpl: ExecFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export type SystemNodeInfo = {
  path: string;
  version: string | null;
  supported: boolean;
};

export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

export function isSystemNodePath(
  nodePath: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return buildSystemNodeCandidates(env, platform).some((candidate) => {
    const normalizedCandidate = normalizeForCompare(candidate, platform);
    return normalized === normalizedCandidate;
  });
}

export async function resolveSystemNodePath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates = buildSystemNodeCandidates(env, platform);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }
  return null;
}

export async function resolveSystemNodeInfo(params: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
}): Promise<SystemNodeInfo | null> {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const systemNode = await resolveSystemNodePath(env, platform);
  if (!systemNode) {
    return null;
  }

  const version = await resolveNodeVersion(systemNode, params.execFile ?? execFileAsync);
  return {
    path: systemNode,
    version,
    supported: isSupportedNodeVersion(version),
  };
}

export function renderSystemNodeWarning(
  systemNode: SystemNodeInfo | null,
  selectedNodePath?: string,
): string | null {
  if (!systemNode || systemNode.supported) {
    return null;
  }
  const versionLabel = systemNode.version ?? "unknown";
  const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
  return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22+.${selectedLabel} Install Node 22+ from nodejs.org or Homebrew.`;
}

/**
 * If `execPath` is a Homebrew Cellar path (versioned), return the stable
 * symlink path (e.g. `/opt/homebrew/bin/node`). Returns `null` when the
 * path is not a Cellar path or the stable symlink does not exist.
 */
export async function resolveStableHomebrewNodePath(
  execPath: string,
  realpathImpl: (p: string) => Promise<string> = (p) => fs.realpath(p),
): Promise<string | null> {
  const match = execPath.match(HOMEBREW_CELLAR_RE);
  if (!match) {
    return null;
  }
  const prefix = match[1]; // e.g. /opt/homebrew
  const formula = match[2]; // e.g. "node" or "node@22"
  // Keg-only formulae (node@22) use opt/<formula>/bin/node; the main
  // "node" formula uses the top-level bin/node symlink.
  const stablePath = formula === "node" ? `${prefix}/bin/node` : `${prefix}/opt/${formula}/bin/node`;
  try {
    // Verify the symlink resolves to the same binary.
    const stableReal = await realpathImpl(stablePath);
    const execReal = await realpathImpl(execPath);
    if (stableReal === execReal) {
      return stablePath;
    }
  } catch {
    // Symlink missing or broken; fall through.
  }
  return null;
}

export async function resolvePreferredNodePath(params: {
  env?: Record<string, string | undefined>;
  runtime?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
  execPath?: string;
  realpath?: (p: string) => Promise<string>;
}): Promise<string | undefined> {
  if (params.runtime !== "node") {
    return undefined;
  }

  // Prefer the node that is currently running `openclaw gateway install`.
  // This respects the user's active version manager (fnm/nvm/volta/etc.).
  const platform = params.platform ?? process.platform;
  const currentExecPath = params.execPath ?? process.execPath;
  if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
    const execFileImpl = params.execFile ?? execFileAsync;
    const version = await resolveNodeVersion(currentExecPath, execFileImpl);
    if (isSupportedNodeVersion(version)) {
      // On Homebrew, process.execPath resolves to a versioned Cellar path
      // that breaks after a Node upgrade. Use the stable symlink instead.
      const stablePath = await resolveStableHomebrewNodePath(currentExecPath, params.realpath);
      return stablePath ?? currentExecPath;
    }
  }

  // Fall back to system node.
  const systemNode = await resolveSystemNodeInfo(params);
  if (!systemNode?.supported) {
    return undefined;
  }
  return systemNode.path;
}
