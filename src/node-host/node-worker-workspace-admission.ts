import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe";
import { tempWorkspace, type TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { isMissingPathError } from "../infra/errno.js";
import type { OpenClawPluginNodeWorkspaceLease } from "../plugins/types.node-host.js";
import type { NodeWorkerDeviceFolders } from "./node-worker-device-folder.js";
import {
  applyNodeWorkerPlatformTrust,
  type NodeWorkerPlatformTrust,
} from "./node-worker-environment.js";
import type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.js";
import {
  ensureContainedDirectory,
  ensureNodeWorkerWorkspaceSessionRoot,
  nodeWorkerWorkspaceLaunchGenerationKey,
  resolveNodeManagedWorkspaceIdentity,
  resolveNodePreparedWorkspaceIdentity,
  type NodeWorkerManagedWorkspaceRequest,
} from "./node-worker-workspace-identity.js";
import type { NodeWorkerWorkspaceProcesses } from "./node-worker-workspace-processes.js";

/** Workspace custody and its admitted process environment share one release/currentness fence. */
function createNodeWorkerManagedWorkspaceLease(params: {
  workspaceDir: string;
  homeDir?: string;
  env: NodeJS.ProcessEnv;
  platformTrust?: NodeWorkerPlatformTrust;
  release: () => void;
  assertCurrent: () => void;
  redactOutput?: (text: string) => string;
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

/** Admission shares the workspace runtime's retention owner rather than introducing another lease store. */
export function createNodeWorkerWorkspaceAcquirer(params: {
  root: string;
  preparedRoot: string;
  deviceFolders: Pick<NodeWorkerDeviceFolders, "acquire">;
  processes: Pick<NodeWorkerWorkspaceProcesses, "captureAdmission">;
  env: NodeJS.ProcessEnv;
  platformTrust?: NodeWorkerPlatformTrust;
  redactOutput?: (text: string) => string;
  isDeviceFolder: (directory: string) => boolean;
  isDeleting: (generation: string) => boolean;
  retain: (namespace: string, generation: string) => () => void;
}) {
  return (
    request: NodeWorkerManagedWorkspaceRequest,
    prepared?: NodeWorkerPreparedWorkspaceRow,
  ) => {
    if (params.isDeviceFolder(request.workspaceDir)) {
      const acquired = params.deviceFolders.acquire(request);
      const gatewayNamespace = request.gatewayNamespace ?? "";
      const generationKey = nodeWorkerWorkspaceLaunchGenerationKey({
        ...request,
        gatewayNamespace,
      });
      if (params.isDeleting(generationKey)) {
        throw new Error("INVALID_REQUEST: node placement workspace is being removed");
      }
      const release = params.retain(gatewayNamespace, generationKey);
      try {
        // The generation owner collects only this private HOME, never the device folder.
        const homeDir = ensureContainedDirectory(
          ensureNodeWorkerWorkspaceSessionRoot(
            params.root,
            gatewayNamespace,
            request.environmentId,
            request.sessionId,
          ),
          String(request.ownerEpoch),
        );
        return { ...acquired, homeDir, release };
      } catch (error) {
        release();
        throw error;
      }
    }
    const identity = prepared
      ? resolveNodePreparedWorkspaceIdentity(params.preparedRoot, prepared, request)
      : resolveNodeManagedWorkspaceIdentity(params.root, request);
    if (params.isDeleting(identity.generationKey)) {
      throw new Error("INVALID_REQUEST: node placement workspace is being removed");
    }
    return createNodeWorkerManagedWorkspaceLease({
      workspaceDir: identity.workspaceDir,
      homeDir: identity.homeDir,
      env: params.env,
      platformTrust: params.platformTrust,
      release: params.retain(identity.gatewayNamespace, identity.generationKey),
      assertCurrent: params.processes.captureAdmission(
        { ...identity, environmentId: request.environmentId },
        request.ownerEpoch,
      ),
      redactOutput: params.redactOutput,
    });
  };
}
