import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { isPathInside } from "../infra/path-guards.js";

function isPrivateModeEnabled(config?: OpenClawConfig): boolean {
  return config?.privateMode?.enabled === true;
}

export function resolvePrivateModeAllowedRoots(config?: OpenClawConfig): string[] {
  if (!isPrivateModeEnabled(config)) {
    return [];
  }
  const configured = config.privateMode?.filesystem?.allowedRoots ?? [];
  return Array.from(
    new Set(
      configured
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

export function shouldBlockAbsolutePathsInPrivateMode(config?: OpenClawConfig): boolean {
  if (!isPrivateModeEnabled(config)) {
    return false;
  }
  return config.privateMode?.filesystem?.blockAbsolutePaths === true;
}

export function assertPrivateModeAllowedPath(params: {
  config?: OpenClawConfig;
  absolutePath: string;
  requestedPath?: string;
}): void {
  if (!isPrivateModeEnabled(params.config)) {
    return;
  }

  const allowedRoots = resolvePrivateModeAllowedRoots(params.config);
  const normalizedAbsolutePath = path.resolve(params.absolutePath);
  const requestedPath = String(params.requestedPath ?? params.absolutePath);
  const requestedIsAbsolute = path.isAbsolute(requestedPath);

  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some(
      (root) => normalizedAbsolutePath === root || isPathInside(root, normalizedAbsolutePath),
    );
    if (!allowed) {
      throw new Error(
        `privateMode blocked path outside allowedRoots: ${requestedPath} (allowedRoots: ${allowedRoots.join(", ")})`,
      );
    }
    return;
  }

  if (requestedIsAbsolute && shouldBlockAbsolutePathsInPrivateMode(params.config)) {
    throw new Error(`privateMode blocked absolute path outside allowedRoots: ${requestedPath}`);
  }
}
