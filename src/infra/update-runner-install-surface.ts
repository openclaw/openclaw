import path from "node:path";
import { isContainerEnvironment } from "./container-environment.js";
import { readPackageName } from "./package-json.js";
import { canAccess, safeStat } from "./path-existence.js";
import { detectGlobalInstallManagerForRoot, type GlobalInstallManager } from "./update-global.js";
import type { UpdateInstallKind } from "./update-install-kind.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import type { CommandRunner, UpdateInstallSurface } from "./update-runner-types.js";

export function resolveUnmanagedUpdateInstallReason() {
  return isContainerEnvironment() ? "container-image-install" : "unmanaged-package-install";
}

export async function looksLikeGitCheckout(root: string): Promise<boolean> {
  return canAccess(path.join(root, ".git"));
}

/** Evidence for an unresolved owner, not permission to mutate an arbitrary directory. */
export async function describeUpdateInstallRoot(root: string): Promise<string> {
  const [git, modules, packageName] = await Promise.all([
    looksLikeGitCheckout(root),
    safeStat(path.join(root, "node_modules")).then((entry) => entry?.isDirectory() ?? false),
    readPackageName(root),
  ]);
  return `Root: ${root}; Git metadata: ${git ? "present" : "absent or unreadable"}; node_modules layout: ${root.split(path.sep).includes("node_modules") ? "package under node_modules" : "outside node_modules"}, local node_modules ${modules ? "present" : "absent or unreadable"}; package.json name: ${packageName ?? "missing or unreadable"}.`;
}

export async function resolveUpdateInstallSurface(opts: {
  root: string | null;
  installKind: UpdateInstallKind;
  packageManager?: GlobalInstallManager;
  timeoutMs?: number;
  runCommand?: CommandRunner;
}): Promise<UpdateInstallSurface> {
  const root = opts.root;
  if (!root || opts.installKind === "unknown" || opts.installKind === "host") {
    return { kind: "missing", mode: "unknown" };
  }
  if (opts.installKind === "git") {
    return { kind: "git", mode: "git", root, packageRoot: root };
  }
  if (opts.installKind === "immutable") {
    return { kind: "immutable", mode: "unknown", root, packageRoot: root };
  }
  // Reuse fresh package ownership. Missing facts keep the interactive runner's
  // own budget so an unavailable startup probe can still recover.
  const globalManager =
    opts.packageManager ??
    (await detectGlobalInstallManagerForRoot(
      (await buildUpdateCommandRunner(opts.runCommand)).runCommand,
      root,
      opts.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
    ));
  if (globalManager) {
    return { kind: "global", mode: globalManager, root, packageRoot: root };
  }
  return { kind: "package-root", mode: "unknown", root, packageRoot: root };
}
