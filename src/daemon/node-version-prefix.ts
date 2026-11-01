import path from "node:path";
import { pathEntryExists, realpathOrResolve } from "../infra/path-existence.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";

export const GATEWAY_NODE_PREFIX_SKEW = "gateway-node-prefix-skew";
export const GATEWAY_NODE_VERSION_MISSING = "gateway-node-version-missing";

const NODE_VERSION_CHANGE_CODES = new Set<string>([
  GATEWAY_NODE_PREFIX_SKEW,
  GATEWAY_NODE_VERSION_MISSING,
]);

export function isNodeVersionChangeIssue(issue: { code: string }): boolean {
  return NODE_VERSION_CHANGE_CODES.has(issue.code);
}

type NodeVersionPrefix = {
  manager: "nvm" | "fnm" | "volta" | "asdf" | "mise" | "nodenv" | "nodebrew";
  root: string;
  version: string;
};

// Group 1 is the version directory. Group 2 is the version name inside it.
const VERSION_PREFIXES: Array<{ manager: NodeVersionPrefix["manager"]; re: RegExp }> = [
  { manager: "nvm", re: /^(.*\/\.nvm\/versions\/node\/(v[^/]+))(?:\/|$)/i },
  { manager: "fnm", re: /^(.*\/fnm\/node-versions\/(v[^/]+))(?:\/|$)/i },
  { manager: "volta", re: /^(.*\/\.volta\/tools\/image\/node\/([^/]+))(?:\/|$)/i },
  { manager: "asdf", re: /^(.*\/\.asdf\/installs\/nodejs\/([^/]+))(?:\/|$)/i },
  { manager: "mise", re: /^(.*\/mise\/installs\/node\/([^/]+))(?:\/|$)/i },
  { manager: "nodenv", re: /^(.*\/\.nodenv\/versions\/([^/]+))(?:\/|$)/i },
  { manager: "nodebrew", re: /^(.*\/\.nodebrew\/node\/(v[^/]+))(?:\/|$)/i },
];

/** Version directory of an nvm, fnm, Volta, asdf, mise, nodenv, or nodebrew path. */
export function resolveNodeVersionPrefix(
  filePath: string | undefined,
): NodeVersionPrefix | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  for (const candidate of VERSION_PREFIXES) {
    const match = candidate.re.exec(normalized);
    const root = match?.[1];
    const version = match?.[2];
    if (!root || !version) {
      continue;
    }
    return { manager: candidate.manager, root, version };
  }
  return undefined;
}

function sameNodeVersionPrefix(left: NodeVersionPrefix, right: NodeVersionPrefix): boolean {
  return left.manager === right.manager && left.root.toLowerCase() === right.root.toLowerCase();
}

export function formatGatewayNodePrefixSkew(
  node: NodeVersionPrefix,
  installed: NodeVersionPrefix,
): string {
  return `Gateway Node ${node.version} (${node.root}) does not own this install (${installed.version} at ${installed.root}). Removing the install's Node version stops the gateway before OpenClaw can start.`;
}

/** Startup warning when the running Node and this package sit under different version directories. */
export function describeGatewayNodePrefixSkew(params: {
  nodePath: string;
  packageRoot: string;
}): string | undefined {
  const node = resolveNodeVersionPrefix(params.nodePath);
  const installed = resolveNodeVersionPrefix(params.packageRoot);
  if (!node || !installed || sameNodeVersionPrefix(node, installed)) {
    return undefined;
  }
  return formatGatewayNodePrefixSkew(node, installed);
}

/**
 * The service Node binary can survive after the version that holds the package is removed.
 * That is not a missing runtime: argv[0] still exists, so install-time Node replacement never runs.
 */
export async function auditGatewayNodeVersionChange(params: {
  nodePath: string | undefined;
  entrypointPath: string | undefined;
}): Promise<ServiceConfigIssue | undefined> {
  const entrypoint = params.entrypointPath;
  const entryPrefix = resolveNodeVersionPrefix(entrypoint);
  if (!entrypoint || !entryPrefix) {
    return undefined;
  }
  const nodePath = params.nodePath;
  const nodeExists = Boolean(nodePath) && (await pathEntryExists(nodePath as string));
  if (!(await pathEntryExists(entrypoint))) {
    if (!nodeExists || !nodePath) {
      return undefined;
    }
    return {
      code: GATEWAY_NODE_VERSION_MISSING,
      message: `Gateway install path is missing after a Node version change (${entrypoint}). The service Node binary still exists at ${nodePath}.`,
      detail: entryPrefix.root,
      level: "recommended",
    };
  }
  const [nodeIdentity, entryIdentity] = await Promise.all([
    nodeExists && nodePath ? realpathOrResolve(nodePath) : Promise.resolve(nodePath),
    realpathOrResolve(entrypoint),
  ]);
  const nodePrefix = resolveNodeVersionPrefix(nodeIdentity);
  const installedPrefix = resolveNodeVersionPrefix(entryIdentity);
  if (!nodePrefix || !installedPrefix || sameNodeVersionPrefix(nodePrefix, installedPrefix)) {
    return undefined;
  }
  return {
    code: GATEWAY_NODE_PREFIX_SKEW,
    message: formatGatewayNodePrefixSkew(nodePrefix, installedPrefix),
    detail: `${nodePrefix.root} -> ${installedPrefix.root}`,
    level: "recommended",
  };
}
