import fs from "node:fs/promises";
import path from "node:path";
import { isContainerEnvironment } from "./container-environment.js";
import { readPackageName } from "./package-json.js";
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import type { CommandRunner, UpdateInstallSurface } from "./update-runner-types.js";

export function resolveUnmanagedUpdateInstallReason() {
  return isContainerEnvironment() ? "container-image-install" : "unmanaged-package-install";
}

export async function looksLikeGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Evidence for an unresolved owner, not permission to mutate an arbitrary directory. */
export async function describeUpdateInstallRoot(root: string): Promise<string> {
  const [git, modules, packageName] = await Promise.all([
    looksLikeGitCheckout(root),
    fs.stat(path.join(root, "node_modules")).then(
      (entry) => entry.isDirectory(),
      () => false,
    ),
    readPackageName(root),
  ]);
  return `Root: ${root}; Git metadata: ${git ? "present" : "absent or unreadable"}; node_modules layout: ${root.split(path.sep).includes("node_modules") ? "package under node_modules" : "outside node_modules"}, local node_modules ${modules ? "present" : "absent or unreadable"}; package.json name: ${packageName ?? "missing or unreadable"}.`;
}

export async function resolveUpdateInstallSurface(opts: {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  timeoutMs?: number;
  runCommand?: CommandRunner;
}): Promise<UpdateInstallSurface> {
  const root = opts.root;
  if (!root || opts.installKind === "unknown") {
    return { kind: "missing", mode: "unknown" };
  }
  if (opts.installKind === "git") {
    return { kind: "git", mode: "git", root, packageRoot: root };
  }
  const { runCommand } = await buildUpdateCommandRunner(opts.runCommand);
  const globalManager = await detectGlobalInstallManagerForRoot(
    runCommand,
    root,
    opts.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
  );
  if (globalManager) {
    return { kind: "global", mode: globalManager, root, packageRoot: root };
  }
  return { kind: "package-root", mode: "unknown", root, packageRoot: root };
}
