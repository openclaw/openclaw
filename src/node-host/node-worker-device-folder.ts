import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  assertNodeWorkspaceDeviceFolderCommand,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import type { NodeWorkerManagedWorkspaceRequest } from "./node-worker-workspace-identity.js";

/** Node-local consent is checked afresh, including symlink resolution, at each use. */
function validateNodeWorkerDeviceFolder(
  folder: string,
  options: { folders?: readonly string[]; privateRoots: readonly string[]; env: NodeJS.ProcessEnv },
): string {
  const resolveDirectory = (value: string): string => {
    const expanded = expandHomePrefix(value, { env: options.env });
    if (!path.isAbsolute(expanded) || expanded.includes("\0")) {
      throw new Error("INVALID_REQUEST: device folder must be an absolute or home-relative path");
    }
    const resolved = fs.realpathSync.native(expanded);
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error("INVALID_REQUEST: device folder must be an existing directory");
    }
    return resolved;
  };
  if (options.folders?.length === 0) {
    throw new Error(
      "INVALID_REQUEST: device-folder sessions are disabled by nodeHost.workerRuns.folders",
    );
  }
  let resolved: string;
  try {
    resolved = resolveDirectory(folder);
  } catch {
    throw new Error(
      "INVALID_REQUEST: device folder must be an existing absolute or home-relative directory",
    );
  }
  if (resolved === path.parse(resolved).root) {
    throw new Error("INVALID_REQUEST: device folder cannot be the filesystem root");
  }
  for (const privateRoot of options.privateRoots) {
    let root = privateRoot;
    try {
      root = fs.realpathSync.native(root);
    } catch {
      // A private root not yet created is still reserved; no directory is created here.
    }
    if (isPathInside(root, resolved) || isPathInside(resolved, root)) {
      throw new Error("INVALID_REQUEST: device folder overlaps private worker storage");
    }
  }
  if (options.folders === undefined) {
    return resolved;
  }
  for (const allowed of options.folders) {
    try {
      if (isPathInside(resolveDirectory(allowed), resolved)) {
        return resolved;
      }
    } catch {
      // A missing/revoked consent root grants no access; another root may still match.
    }
  }
  throw new Error("INVALID_REQUEST: device folder is not allowed by nodeHost.workerRuns.folders");
}

export class NodeWorkerDeviceFolders {
  constructor(
    private readonly options: {
      folders?: readonly string[];
      privateRoots: readonly string[];
      env: NodeJS.ProcessEnv;
    },
  ) {
    this.options = {
      ...options,
      folders: options.folders === undefined ? undefined : [...options.folders],
    };
  }

  validate(folder: string): string {
    return validateNodeWorkerDeviceFolder(folder, this.options);
  }

  acquire(request: NodeWorkerManagedWorkspaceRequest) {
    const workspaceDir = this.validate(request.workspaceDir);
    if (
      workspaceDir !== request.workspaceDir ||
      !request.sessionKey ||
      !Number.isSafeInteger(request.ownerEpoch) ||
      request.ownerEpoch < 1
    ) {
      throw new Error(
        "INVALID_REQUEST: device folder acquisition requires its canonical path and bound session",
      );
    }
    const identity = fs.statSync(workspaceDir);
    const assertCurrent = () => {
      const current = this.validate(workspaceDir);
      const stat = fs.statSync(current);
      if (current !== workspaceDir || stat.dev !== identity.dev || stat.ino !== identity.ino) {
        throw new Error("INVALID_REQUEST: acquired device folder changed before execution");
      }
    };
    return { workspaceDir, assertCurrent };
  }

  validateCommand(input: NodeWorkerWorkspaceExecInput): string | undefined {
    const folder = input.deviceFolder === undefined ? undefined : this.validate(input.deviceFolder);
    assertNodeWorkspaceDeviceFolderCommand(input);
    return folder;
  }
}
