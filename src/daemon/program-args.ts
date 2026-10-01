/** Builds runtime command arguments for gateway and node service installs. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import type { GatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import { resolveBrewOpenClawPath } from "../infra/brew.js";
import {
  buildGatewayDistEntrypointCandidates,
  buildGatewayInstallEntrypointCandidates,
  findFirstAccessibleGatewayEntrypoint,
  isGatewayDistEntrypointPath,
} from "./gateway-entrypoint.js";
import { resolveGatewayHeapExecArgv } from "./gateway-heap.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

type GatewayProgramArgs = {
  programArguments: string[];
  workingDirectory?: string;
};

export const OPENCLAW_WRAPPER_ENV_KEY = "OPENCLAW_WRAPPER";

const canAccessEntrypoint = (candidate: string) =>
  fs.access(candidate).then(
    () => true,
    () => false,
  );

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve CLI entrypoint path");
  }

  const normalized = path.resolve(argv1);
  const resolvedPath = await fs.realpath(normalized).catch(() => normalized);
  const looksLikeDist = isGatewayDistEntrypointPath(resolvedPath);
  if (looksLikeDist) {
    // Existing installed command lines may point at versioned pnpm realpaths.
    // Repair prefers stable package symlink paths when they still exist.
    const preferredDistEntrypoint = await findFirstAccessibleGatewayEntrypoint(
      buildGatewayDistEntrypointCandidates(normalized, resolvedPath),
      canAccessEntrypoint,
    );
    if (preferredDistEntrypoint) {
      return preferredDistEntrypoint;
    }
    // Prefer the original (possibly symlinked) path over the resolved realpath.
    // This keeps LaunchAgent/systemd paths stable across package version updates,
    // since symlinks like node_modules/openclaw -> .pnpm/openclaw@X.Y.Z/...
    // are automatically updated by pnpm, while the resolved path contains
    // version-specific directories that break after updates.
    if (
      isGatewayDistEntrypointPath(normalized) &&
      normalized !== resolvedPath &&
      (await canAccessEntrypoint(normalized))
    ) {
      return normalized;
    }
    return resolvedPath;
  }

  const distCandidates = buildDistCandidates(resolvedPath, normalized);

  const entrypoint = await findFirstAccessibleGatewayEntrypoint(
    distCandidates,
    canAccessEntrypoint,
  );
  if (entrypoint) {
    return entrypoint;
  }

  throw new Error(
    `Cannot find built CLI at ${distCandidates.join(" or ")}. Run "pnpm build" first, or use dev mode.`,
  );
}

function buildDistCandidates(...inputs: string[]): string[] {
  const roots: string[] = [];
  for (const inputPath of inputs) {
    const baseDir = path.dirname(inputPath);
    roots.push(path.resolve(baseDir, ".."), baseDir);
    const parts = inputPath.split(path.sep);
    const binIndex = parts.lastIndexOf(".bin");
    if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
      // node_modules/.bin commands select the package root sibling.
      roots.push(path.join(parts.slice(0, binIndex).join(path.sep), path.basename(inputPath)));
    }
  }
  return [...new Set(roots.flatMap(buildGatewayInstallEntrypointCandidates))];
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
    // Wrappers replace the runtime executable, so require execute permission up
    // front rather than generating a service that fails at boot.
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

async function resolveCliProgramArguments(params: {
  args: string[];
  dev?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const wrapperPath = await resolveOpenClawWrapperPath(params.wrapperPath);
  if (wrapperPath) {
    return { programArguments: [wrapperPath, ...params.args] };
  }

  if (!params.runtimePath?.trim()) {
    throw new Error(
      params.runtime === "bun"
        ? "No supported Bun runtime was selected for the daemon. Install Bun 1.4 or newer with WAL-reset-safe node:sqlite, then retry."
        : `No supported Node runtime was selected for the daemon. Install Node ${SUPPORTED_NODE_VERSIONS}, then retry.`,
    );
  }
  const runtimePath = params.runtimePath;

  if (params.dev) {
    const repoRoot = resolveRepoRootForDev();
    const devCliPath = path.join(repoRoot, "src", "entry.ts");
    await fs.access(devCliPath);
    return {
      programArguments:
        params.runtime === "bun"
          ? [runtimePath, devCliPath, ...params.args]
          : [runtimePath, "--import", "tsx", devCliPath, ...params.args],
      workingDirectory: repoRoot,
    };
  }

  const cliEntrypointPath = await resolveCliEntrypointPathForService();
  return {
    programArguments: [
      runtimePath,
      (await resolveBrewOpenClawPath(cliEntrypointPath)) ?? cliEntrypointPath,
      ...params.args,
    ],
  };
}

export async function resolveGatewayProgramArguments(params: {
  port: number;
  allowUnconfigured?: boolean;
  dev?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimePath?: string;
  wrapperPath?: string;
  existingCommand?: GatewayServiceCommandConfig | null;
}): Promise<GatewayProgramArgs> {
  const gatewayArgs = ["gateway", "--port", String(params.port)];
  if (params.allowUnconfigured) {
    gatewayArgs.push("--allow-unconfigured");
  }
  const result = await resolveCliProgramArguments({
    args: gatewayArgs,
    dev: params.dev,
    runtime: params.runtime,
    runtimePath: params.runtimePath,
    wrapperPath: params.wrapperPath,
  });
  if (params.runtime === "node" && !params.wrapperPath?.trim()) {
    // Restore operator-owned heap controls already stored in the service argv.
    // An automatic process-wide --max-old-space-size is intentionally not added:
    // it would override every worker's resourceLimits.maxOldGenerationSizeMb.
    result.programArguments.splice(1, 0, ...resolveGatewayHeapExecArgv(params.existingCommand));
  }
  return result;
}

export async function resolveNodeProgramArguments(params: {
  host: string;
  port: number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
  dev?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const args = ["node", "run", "--host", params.host, "--port", String(params.port)];
  if (params.tls === false && !params.tlsFingerprint) {
    // Managed services must carry plaintext explicitly; omission would let the
    // node runtime re-inherit TLS from the operator's global Gateway config.
    args.push("--no-tls");
  } else if (params.tls || params.tlsFingerprint) {
    args.push("--tls");
  }
  if (params.tlsFingerprint) {
    args.push("--tls-fingerprint", params.tlsFingerprint);
  }
  if (params.contextPath) {
    args.push("--context-path", params.contextPath);
  }
  if (params.nodeId) {
    args.push("--node-id", params.nodeId);
  }
  if (params.displayName) {
    args.push("--display-name", params.displayName);
  }
  if (params.installedAppsSharing !== undefined) {
    args.push(params.installedAppsSharing ? "--share-installed-apps" : "--no-share-installed-apps");
  }
  if (params.allCommands) {
    args.push("--all-commands");
  } else if (params.commands !== undefined) {
    args.push("--commands", params.commands.join(","));
  }
  return resolveCliProgramArguments({
    args,
    dev: params.dev,
    runtime: params.runtime,
    runtimePath: params.runtimePath,
    wrapperPath: params.wrapperPath,
  });
}
