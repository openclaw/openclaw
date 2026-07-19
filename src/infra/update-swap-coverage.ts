/** Install-layout gate for update swap protection. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

type UpdateSwapCoverage =
  | {
      kind: "managed-prefix";
      protection: "transactional-rollback";
      prefix: string;
      nodePath: string;
    }
  | {
      kind: "npm-global" | "pnpm-global" | "git" | "windows" | "unknown";
      protection: "detect-warn";
      reason: string;
    };

async function hasManagedPrefixProvenance(params: {
  prefix: string;
  packageRoot: string;
  nodeSegment: string;
}): Promise<boolean> {
  const nodeVersionRoot = path.join(params.prefix, "tools", params.nodeSegment);
  const nodeLink = path.join(params.prefix, "tools", "node");
  const nodePath = path.join(nodeLink, "bin", "node");
  const wrapperPath = path.join(params.prefix, "bin", "openclaw");
  const expectedWrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec "${nodePath}" "${params.packageRoot}/dist/entry.js" "$@"`,
    "",
  ].join("\n");
  try {
    const [
      prefixReal,
      packageReal,
      nodeLinkReal,
      prefixStat,
      packageStat,
      packageParentStat,
      wrapperStat,
      wrapper,
      uid,
    ] = await Promise.all([
      fs.realpath(params.prefix),
      fs.realpath(params.packageRoot),
      fs.realpath(nodeLink),
      fs.lstat(params.prefix),
      fs.lstat(params.packageRoot),
      fs.lstat(path.dirname(params.packageRoot)),
      fs.lstat(wrapperPath),
      fs.readFile(wrapperPath, "utf8"),
      Promise.resolve(process.getuid?.()),
    ]);
    if (
      prefixReal !== params.prefix ||
      packageReal !== params.packageRoot ||
      nodeLinkReal !== nodeVersionRoot ||
      !wrapperStat.isFile() ||
      wrapperStat.isSymbolicLink() ||
      wrapper !== expectedWrapper ||
      uid === undefined ||
      prefixStat.uid !== uid ||
      packageStat.uid !== uid ||
      packageParentStat.uid !== uid ||
      wrapperStat.uid !== uid
    ) {
      return false;
    }
    await Promise.all([
      fs.access(nodePath, fsConstants.X_OK),
      fs.access(params.packageRoot, fsConstants.R_OK | fsConstants.W_OK),
      fs.access(path.dirname(params.packageRoot), fsConstants.R_OK | fsConstants.W_OK),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveUpdateSwapCoverage(params: {
  packageRoot: string;
  manager: string;
  platform?: NodeJS.Platform;
}): Promise<UpdateSwapCoverage> {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    return {
      kind: "windows",
      protection: "detect-warn",
      reason: "managed-prefix swap protection currently requires the POSIX service wrapper",
    };
  }
  const requestedRoot = path.resolve(params.packageRoot);
  const normalized = await fs.realpath(requestedRoot).catch(() => requestedRoot);
  const segments = normalized.split(path.sep);
  const toolsIndex = segments.lastIndexOf("tools");
  const nodeSegment = segments[toolsIndex + 1];
  const suffix = segments.slice(toolsIndex + 2).join("/");
  if (
    params.manager === "npm" &&
    toolsIndex > 0 &&
    nodeSegment &&
    (nodeSegment === "node" || nodeSegment.startsWith("node-v")) &&
    suffix === "lib/node_modules/openclaw"
  ) {
    const prefix = segments.slice(0, toolsIndex).join(path.sep) || path.sep;
    if (await hasManagedPrefixProvenance({ prefix, packageRoot: normalized, nodeSegment })) {
      return {
        kind: "managed-prefix",
        protection: "transactional-rollback",
        prefix,
        nodePath: path.join(prefix, "tools", "node", "bin", "node"),
      };
    }
    return {
      kind: "npm-global",
      protection: "detect-warn",
      reason: "the local-prefix installer wrapper or writable ownership could not be verified",
    };
  }
  if (params.manager === "npm") {
    return {
      kind: "npm-global",
      protection: "detect-warn",
      reason: "the global package parent may be root-owned or shared with unrelated packages",
    };
  }
  if (params.manager === "pnpm") {
    return {
      kind: "pnpm-global",
      protection: "detect-warn",
      reason: "pnpm's content-addressed global layout is not an atomic managed prefix",
    };
  }
  if (params.manager === "git") {
    return {
      kind: "git",
      protection: "detect-warn",
      reason: "a source checkout does not provide an immutable retained package root",
    };
  }
  return {
    kind: "unknown",
    protection: "detect-warn",
    reason: "the install owner could not be proven safe for package swapping",
  };
}

export function formatUpdateSwapCoverageWarning(coverage: UpdateSwapCoverage): string | null {
  if (coverage.protection === "transactional-rollback") {
    return null;
  }
  return `Automatic update rollback is unavailable for this ${coverage.kind} install: ${coverage.reason}. Reinstall with the managed website installer for protected updates: https://openclaw.ai/install.sh`;
}
