import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { realpathOrResolve, statIfExists } from "../infra/path-existence.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";

export const GATEWAY_NODE_PREFIX_SKEW = "gateway-node-prefix-skew";
export const GATEWAY_NODE_VERSION_MISSING = "gateway-node-version-missing";
export const GATEWAY_NODE_VERSION_INSPECT_FAILED = "gateway-node-version-inspect-failed";

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
// fnm publishes both ~/.fnm and ~/.local/share/fnm (and the macOS Application Support root).
const VERSION_PREFIXES: Array<{
  manager: NodeVersionPrefix["manager"];
  re: RegExp;
  binary: string;
}> = [
  { manager: "nvm", re: /^(.*\/\.nvm\/versions\/node\/(v[^/]+))(?:\/|$)/i, binary: "bin/node" },
  {
    manager: "fnm",
    re: /^(.*\/\.?fnm\/node-versions\/(v[^/]+))(?:\/|$)/i,
    binary: "installation/bin/node",
  },
  {
    manager: "volta",
    re: /^(.*\/\.volta\/tools\/image\/node\/([^/]+))(?:\/|$)/i,
    binary: "bin/node",
  },
  {
    manager: "asdf",
    re: /^(.*\/\.asdf\/installs\/nodejs\/([^/]+))(?:\/|$)/i,
    binary: "bin/node",
  },
  { manager: "mise", re: /^(.*\/mise\/installs\/node\/([^/]+))(?:\/|$)/i, binary: "bin/node" },
  { manager: "nodenv", re: /^(.*\/\.nodenv\/versions\/([^/]+))(?:\/|$)/i, binary: "bin/node" },
  {
    manager: "nodebrew",
    re: /^(.*\/\.nodebrew\/node\/(v[^/]+))(?:\/|$)/i,
    binary: "bin/node",
  },
];

/** Version directory of an nvm, fnm, Volta, asdf, mise, nodenv, or nodebrew path. */
function resolveNodeVersionPrefix(filePath: string | undefined): NodeVersionPrefix | undefined {
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

function nodeBinaryForPrefix(prefix: NodeVersionPrefix): string {
  if (process.platform === "win32" && prefix.manager === "fnm") {
    return `${prefix.root}/installation/node.exe`;
  }
  const spec = VERSION_PREFIXES.find((candidate) => candidate.manager === prefix.manager);
  return `${prefix.root}/${spec?.binary ?? "bin/node"}`;
}

function formatGatewayNodePrefixSkew(
  node: NodeVersionPrefix,
  installed: NodeVersionPrefix,
): string {
  return `Gateway Node ${node.version} (${node.root}) does not own this install (${installed.version} at ${installed.root}). Removing the install's Node version stops the gateway before OpenClaw can start.`;
}

/** Startup warning when the running Node and this package sit under different version directories. */
function describeGatewayNodePrefixSkew(params: {
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

type GatewayNodeVersionRepair = {
  /** True when the planned Node binary sits in the install's version directory. */
  resolvesSplit: boolean;
  /** What Doctor keeps. Empty when the plan already selects the install's Node. */
  remains: string;
  /** Managed-unit advice, including the command that addresses the finding. */
  action: string;
};

/**
 * Advice follows the install plan. A supported recorded Node and an explicit
 * runtime pin stay put, so Doctor reinstalls that same Node unless the plan
 * already selects the version that holds the package.
 */
export function describeGatewayNodeVersionRepair(params: {
  code: string;
  entrypointPath?: string;
  plannedNodePath?: string;
  recordedNodePath?: string;
  pinnedRuntimePath?: string;
}): GatewayNodeVersionRepair {
  const installed = resolveNodeVersionPrefix(params.entrypointPath);
  const planned = resolveNodeVersionPrefix(params.plannedNodePath);
  const resolvesSplit = Boolean(
    params.code === GATEWAY_NODE_PREFIX_SKEW &&
    planned &&
    installed &&
    sameNodeVersionPrefix(planned, installed),
  );
  const pin = params.pinnedRuntimePath?.trim() || undefined;
  const keptNode = params.plannedNodePath || params.recordedNodePath;
  const installNode = installed ? nodeBinaryForPrefix(installed) : undefined;
  const selectCommand = installNode
    ? formatCliCommand(
        `openclaw gateway install --runtime-path ${quoteCliArg(installNode)} --force`,
      )
    : formatCliCommand("openclaw gateway install --runtime-path <path> --force");

  const reinstallCommand = formatCliCommand("openclaw gateway install --force");
  const doctorCommand = formatCliCommand("openclaw doctor --fix");
  if (params.code === GATEWAY_NODE_VERSION_MISSING) {
    return {
      resolvesSplit: false,
      remains: pin
        ? `An explicit runtime pin keeps ${pin}.`
        : `Doctor keeps the service Node at ${keptNode} because that binary still exists.`,
      action: `The package path is gone. Reinstall OpenClaw under a supported Node, then run \`${reinstallCommand}\` from that install.`,
    };
  }
  if (resolvesSplit && params.plannedNodePath) {
    return {
      resolvesSplit: true,
      remains: "",
      action: `Stop the service and rerun \`${doctorCommand}\` to point it at ${params.plannedNodePath}.`,
    };
  }
  if (pin) {
    return {
      resolvesSplit: false,
      remains: `An explicit runtime pin keeps ${pin}.`,
      action: `\`${doctorCommand}\` reinstalls that pin. Replace it with the Node that owns this install: \`${selectCommand}\`.`,
    };
  }
  if (keptNode) {
    return {
      resolvesSplit: false,
      remains: `Doctor keeps this supported Node at ${keptNode}.`,
      action: `\`${doctorCommand}\` reinstalls that Node. Select the Node that owns this install with \`${selectCommand}\`.`,
    };
  }
  return {
    resolvesSplit: false,
    remains: "Doctor keeps a supported service Node and any explicit runtime pin.",
    action: `\`${doctorCommand}\` reinstalls that Node. Select the Node that owns this install with \`${selectCommand}\`.`,
  };
}

/** Startup warning plus the repair that matches a retained or pinned service Node. */
export function formatGatewayNodePrefixStartupWarning(params: {
  nodePath: string;
  packageRoot: string;
}): string | undefined {
  const skew = describeGatewayNodePrefixSkew(params);
  if (!skew) {
    return undefined;
  }
  const repair = describeGatewayNodeVersionRepair({
    code: GATEWAY_NODE_PREFIX_SKEW,
    entrypointPath: params.packageRoot,
    recordedNodePath: params.nodePath,
  });
  return `${skew} ${repair.remains} ${repair.action}`;
}

function formatInspectionError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown filesystem error";
}

/**
 * The service Node binary can survive after the version that holds the package is removed.
 * That is not a missing runtime: argv[0] still exists, so install-time Node replacement never runs.
 * Unreadable version directories stay inside this audit so Doctor and gateway status keep their other findings.
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
  try {
    return await inspectGatewayNodeVersionChange({
      entrypoint,
      entryPrefix,
      nodePath: params.nodePath,
    });
  } catch (error) {
    return {
      code: GATEWAY_NODE_VERSION_INSPECT_FAILED,
      message: `Could not inspect whether the gateway Node and install share a version directory: ${formatInspectionError(error)}.`,
      level: "recommended",
      repair: "host",
    };
  }
}

async function inspectGatewayNodeVersionChange(params: {
  entrypoint: string;
  entryPrefix: NodeVersionPrefix;
  nodePath: string | undefined;
}): Promise<ServiceConfigIssue | undefined> {
  const nodePath = params.nodePath;
  const nodeExists = nodePath ? (await statIfExists(nodePath)) !== undefined : false;
  if (!(await statIfExists(params.entrypoint))) {
    if (!nodeExists || !nodePath) {
      return undefined;
    }
    return {
      code: GATEWAY_NODE_VERSION_MISSING,
      message: `Gateway install path is missing after a Node version change (${params.entrypoint}). The service Node binary still exists at ${nodePath}.`,
      detail: params.entryPrefix.root,
      level: "recommended",
    };
  }
  const [nodeIdentity, entryIdentity] = await Promise.all([
    nodeExists && nodePath ? realpathOrResolve(nodePath) : Promise.resolve(nodePath),
    realpathOrResolve(params.entrypoint),
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
