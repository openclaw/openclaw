import fs from "node:fs";
import path from "node:path";
import { prepareFilesystemRestrictedLaunch } from "@openclaw/proc-safe/filesystem-launch";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  nodeWorkerManagedWorkspacePath,
  type NodeWorkerWorkspaceLaunchReference,
} from "./node-worker-workspace-identity.js";

/** Node-owned grants; a worker descriptor cannot add filesystem permissions. */
export async function prepareNodeWorkerFilesystem(params: {
  workspaceDir: string;
  bundleRoot: string;
  placement?: NodeWorkerWorkspaceLaunchReference;
  entry: string;
  homeDir?: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  /** Node-owned workspace operations may target their private staging directory. */
  commandWorkspace?: true;
  /** Local Git inspection must not consume a model-writable HOME. */
  temporaryHome?: true;
  executable?: string;
  /** Fresh operation-owned outputs, never paths from a worker descriptor. */
  outputDirectories?: readonly string[];
}) {
  if (process.platform !== "linux") {
    throw new Error("Filesystem-isolated node workers require Linux with Landlock ABI 3 or later");
  }
  const capturedHome = params.homeDir ?? params.env.HOME;
  if (!capturedHome) {
    throw new Error("Filesystem-isolated node workers require a captured execution HOME");
  }
  const workspace = fs.realpathSync.native(params.workspaceDir);
  const hostHome = fs.realpathSync.native(capturedHome);
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!packageRoot) {
    throw new Error("Cannot locate the node runtime for filesystem isolation");
  }
  const runtimePaths = [path.dirname(params.entry), packageRoot, path.dirname(process.execPath)];
  const readOnlyPaths = [
    ...runtimePaths,
    "/bin",
    "/sbin",
    "/usr",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/local/lib",
    "/usr/local/lib64",
    "/usr/local/libexec",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
    "/etc/ld.so.cache",
    "/etc/gitconfig",
    "/dev/urandom",
    "/dev/random",
    "/proc",
  ].filter((value) => fs.existsSync(value));
  for (const key of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
    const value = params.env[key];
    if (value) {
      if (!fs.statSync(value).isFile()) {
        throw new Error("Captured platform CA must be a regular file");
      }
      readOnlyPaths.push(value);
    }
  }
  const protectedNamespaceParents: string[] = [];
  const protectRuntimePath = (root: string) => {
    const canonicalRoot = fs.realpathSync.native(root);
    const inspectedPaths = new Set<string>();
    // Trusted callers may resolve the original pathname again after launch.
    // Ordinary directories before .. can be replaced too; protect entry parents.
    const protectPathEntries = (value: string) => {
      const absolute = path.isAbsolute(value) ? value : `${process.cwd()}/${value}`;
      for (
        let current = absolute;
        current !== path.dirname(current);
        current = path.dirname(current)
      ) {
        // A trailing slash makes lstat follow the link instead of inspecting its entry.
        current = current.replace(/\/+$/u, "") || "/";
        if (inspectedPaths.has(current)) {
          break;
        }
        inspectedPaths.add(current);
        const name = path.basename(current);
        if (name === "." || name === "..") {
          continue;
        }
        const parent = fs.realpathSync.native(path.dirname(current));
        protectedNamespaceParents.push(parent);
        if (fs.lstatSync(current).isSymbolicLink()) {
          const target = fs.readlinkSync(current);
          // Preserve segments such as link/.. until the filesystem resolves them.
          protectPathEntries(path.isAbsolute(target) ? target : `${parent}/${target}`);
        }
      }
    };
    protectPathEntries(root);
    return canonicalRoot;
  };
  const stateRoot = protectRuntimePath(params.bundleRoot);
  const { placement } = params;
  const assignedRoot = placement && nodeWorkerManagedWorkspacePath(stateRoot, placement);
  const assignedWorkspace = workspace === params.workspaceDir && workspace === assignedRoot;
  // Existing device folders keep their private HOME at the node-owned placement path.
  const assignedHome = hostHome === params.homeDir && hostHome === assignedRoot;
  const runtimeStorage =
    placement && (assignedWorkspace || assignedHome || params.commandWorkspace === true)
      ? path.join(params.bundleRoot, placement.gatewayNamespace, "bundles")
      : params.bundleRoot;
  const protectedRuntimePaths = [
    ...new Set([
      runtimeStorage,
      ...runtimePaths,
      // Keep broad read grants from excluding otherwise disjoint project directories.
      ...readOnlyPaths.filter((root) => root !== "/usr" && root !== "/proc"),
    ]),
  ].map((root) =>
    params.commandWorkspace && root === runtimeStorage && !fs.existsSync(root)
      ? path.join(protectRuntimePath(path.dirname(root)), path.basename(root))
      : protectRuntimePath(root),
  );
  // These roots allow writable children, but their lookup entries must stay trusted.
  protectRuntimePath(capturedHome);
  const temporaryParent = protectRuntimePath(resolvePreferredOpenClawTmpDir({ purpose: "worker" }));
  const assertWritableRoot = (
    kind: "workspace" | "model HOME" | "scratch" | "command output",
    directory: string,
  ) => {
    // Landlock grants are additive: a read-only rule cannot subtract a write grant.
    const assigned =
      (kind === "workspace" && (assignedWorkspace || params.commandWorkspace === true)) ||
      (kind === "model HOME" && (assignedHome || params.commandWorkspace === true)) ||
      kind === "command output";
    if (
      (!assigned && isPathInside(stateRoot, directory)) ||
      protectedRuntimePaths.some(
        (root) => isPathInside(directory, root) || isPathInside(root, directory),
      ) ||
      protectedNamespaceParents.some((parent) => isPathInside(directory, parent)) ||
      [hostHome, temporaryParent].some((root) => isPathInside(directory, root))
    ) {
      throw new Error(
        `Worker writable storage cannot use the ${kind} path ${JSON.stringify(directory)}. Choose a location separate from protected node runtime and shared storage.`,
      );
    }
  };
  assertWritableRoot("workspace", workspace);
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "worker-"));
  const cleanup = () => removeTemporaryArtifacts(temporaryRoot, "Node worker scratch");
  try {
    assertWritableRoot("scratch", temporaryRoot);
    const home = path.join(params.temporaryHome ? temporaryRoot : hostHome, "model-home");
    assertWritableRoot("model HOME", home);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(home);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Isolated model HOME must be an owned private directory");
    }
    const outputDirectories = (params.outputDirectories ?? []).map((directory) =>
      fs.realpathSync.native(directory),
    );
    for (const directory of outputDirectories) {
      assertWritableRoot("command output", directory);
    }
    const launch = prepareFilesystemRestrictedLaunch({
      executable: params.executable ?? process.execPath,
      args: params.args,
      cwd: workspace,
      readOnlyPaths: readOnlyPaths.map((root) => fs.realpathSync.native(root)),
      readWritePaths: [workspace, home, temporaryRoot, ...outputDirectories, "/dev/null"],
      // Apply only after confinement: the trusted process owner must never use
      // a model-writable HOME or code cache.
      env: {
        HOME: home,
        PATH: path.join(home, ".local", "bin") + path.delimiter + (params.env.PATH ?? ""),
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        OPENCLAW_INTERNAL_WORKER_TMPDIR: temporaryRoot,
        NODE_COMPILE_CACHE: path.join(temporaryRoot, "node-compile-cache"),
      },
    });
    // Native helpers can be installed outside the OpenClaw package tree.
    protectedRuntimePaths.push(
      protectRuntimePath(path.dirname(launch.command)),
      path.dirname(protectRuntimePath(launch.command)),
    );
    assertWritableRoot("workspace", workspace);
    assertWritableRoot("model HOME", home);
    assertWritableRoot("scratch", temporaryRoot);
    for (const directory of outputDirectories) {
      assertWritableRoot("command output", directory);
    }
    return { ...launch, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
