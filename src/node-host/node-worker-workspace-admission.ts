import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe";
import { tempWorkspace, type TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { resolveStateDir } from "../config/paths.js";
import { isMissingPathError } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { tightenPrivateDirRootSync } from "../infra/private-dir-mode.js";
import type { OpenClawPluginNodeWorkspaceLease } from "../plugins/types.node-host.js";
import { isWorkspaceInspectionCommand } from "../worker/workspace-inspection-protocol.js";
import { inspectSessionWorkspace } from "../worker/workspace-inspection.js";
import {
  applyNodeWorkerPlatformTrust,
  captureNodeWorkerPlatformTrust,
  snapshotNodeWorkerExecutionEnv,
  type NodeWorkerManagedIdentityTransport,
  type NodeWorkerPlatformTrust,
} from "./node-worker-environment.js";
import { createNodeWorkerCredentialScrubber } from "./node-worker-output.js";

export async function inspectNodeWorkerWorkspace(
  argv: readonly string[],
  workspacePath: string,
  sessionRoot: string,
  input?: string,
  signal?: AbortSignal,
) {
  if (!isWorkspaceInspectionCommand(argv)) {
    return undefined;
  }
  const stat = fsSync.lstatSync(workspacePath, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("INVALID_REQUEST: workspace inspection root is unavailable");
  }
  const workspaceDir = fsSync.realpathSync.native(workspacePath);
  if (!isPathInside(sessionRoot, workspaceDir)) {
    throw new Error("INVALID_REQUEST: workspace inspection root is unavailable");
  }
  return {
    workspaceDir,
    stdout: await inspectSessionWorkspace(workspaceDir, input, () => signal?.throwIfAborted()),
  };
}

/** Admit the private root and freeze the node-owned execution environment together. */
export function prepareNodeWorkerWorkspaceCustody(options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  managedIdentityTransport?: NodeWorkerManagedIdentityTransport;
  platformTrust?: NodeWorkerPlatformTrust;
}) {
  const source = options.env ?? process.env;
  const configuredRoot = path.resolve(
    options.root ?? path.join(resolveStateDir(source), "node-host"),
  );
  fsSync.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  const root = fsSync.realpathSync.native(configuredRoot);
  tightenPrivateDirRootSync(root, 0o700);
  const platformTrust =
    options.platformTrust && captureNodeWorkerPlatformTrust(options.platformTrust);
  return {
    root,
    platformTrust,
    env: snapshotNodeWorkerExecutionEnv(source, options.managedIdentityTransport, platformTrust),
    credentialScrubber: options.managedIdentityTransport
      ? createNodeWorkerCredentialScrubber(options.managedIdentityTransport.header)
      : undefined,
  };
}

/** Workspace custody and its admitted process environment share one release/currentness fence. */
export function createNodeWorkerManagedWorkspaceLease(params: {
  workspaceDir: string;
  homeDir?: string;
  env: NodeJS.ProcessEnv;
  platformTrust?: NodeWorkerPlatformTrust;
  release: () => void;
  assertCurrent: () => void;
  redactOutput?: (text: string) => string;
  repositoryReadiness?: OpenClawPluginNodeWorkspaceLease["repositoryReadiness"];
}): OpenClawPluginNodeWorkspaceLease {
  try {
    params.assertCurrent();
  } catch (error) {
    params.release();
    throw error;
  }
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("node placement workspace lease is released");
    }
    params.assertCurrent();
  };
  return {
    workspaceDir: params.workspaceDir,
    ...(params.homeDir ? { homeDir: params.homeDir } : {}),
    release: () => {
      active = false;
      params.release();
    },
    ...(params.repositoryReadiness
      ? {
          repositoryReadiness: {
            wait: async (signal: AbortSignal) => {
              assertCurrent();
              await params.repositoryReadiness!.wait(signal);
              assertCurrent();
            },
            assertCurrent: () => {
              assertCurrent();
              params.repositoryReadiness!.assertCurrent();
            },
          },
        }
      : {}),
    processEnvironment: {
      assertCurrent,
      prepare: (sanitizedEnv) => {
        assertCurrent();
        const env = { ...sanitizedEnv };
        if (params.platformTrust) {
          applyNodeWorkerPlatformTrust(env, params.platformTrust);
        }
        delete env.IDENTITY_ENDPOINT;
        delete env.IDENTITY_HEADER;
        if (
          params.env.IDENTITY_ENDPOINT !== undefined &&
          params.env.IDENTITY_HEADER !== undefined
        ) {
          env.IDENTITY_ENDPOINT = params.env.IDENTITY_ENDPOINT;
          env.IDENTITY_HEADER = params.env.IDENTITY_HEADER;
        }
        return env;
      },
      redactOutput: (text) => params.redactOutput?.(text) ?? text,
    },
  };
}

async function describeWritableAncestor(rootDir: string): Promise<string | undefined> {
  let canonicalRoot = path.resolve(rootDir);
  for (;;) {
    try {
      canonicalRoot = await fs.realpath(canonicalRoot);
      break;
    } catch (error) {
      const parent = path.dirname(canonicalRoot);
      if (!isMissingPathError(error) || parent === canonicalRoot) {
        throw error;
      }
      canonicalRoot = parent;
    }
  }
  const ancestry: string[] = [];
  for (let current = canonicalRoot; ; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) {
      break;
    }
  }
  for (const directory of ancestry.toReversed()) {
    const stat = await fs.stat(directory);
    // Diagnostic only: fs-safe remains the authority, including owner and sticky checks.
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      const writable = (stat.mode & 0o002) !== 0 ? "world-writable" : "group-writable";
      const quotedPath = `'${directory.replaceAll("'", "'\\''")}'`;
      return `State directory ${directory} is ${writable} without sticky protection; run chmod go-w ${quotedPath} on the node, then restart the node host.`;
    }
  }
  return undefined;
}

/** Share startup and transfer admission without weakening fs-safe's mutation-time checks. */
export async function createNodeWorkerTempWorkspace(options: TempWorkspaceOptions) {
  try {
    return await tempWorkspace(options);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "insecure-permissions" && options.rootDir) {
      const message = await describeWritableAncestor(options.rootDir).catch(() => undefined);
      if (message) {
        throw new Error(message, { cause: error });
      }
    }
    throw error;
  }
}
