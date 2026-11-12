import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const OPENSHELL_RESTRICT_EXEC = "/usr/local/bin/openshell-sandbox";

/** Node-owned grants; a worker descriptor cannot add filesystem permissions. */
export async function prepareNodeWorkerFilesystem(params: {
  workspaceDir: string;
  bundleRoot: string;
  entry: string;
  homeDir?: string;
  env: NodeJS.ProcessEnv;
  args: string[];
}) {
  if (process.platform !== "linux") {
    throw new Error("Filesystem-isolated node workers require Linux with Landlock ABI 3 or later");
  }
  try {
    fs.accessSync(OPENSHELL_RESTRICT_EXEC, fs.constants.X_OK);
  } catch {
    throw new Error(`Filesystem-isolated node workers require ${OPENSHELL_RESTRICT_EXEC}`);
  }
  const capturedHome = params.homeDir ?? params.env.HOME;
  if (!capturedHome) {
    throw new Error("Filesystem-isolated node workers require a captured execution HOME");
  }
  const workspace = fs.realpathSync.native(params.workspaceDir);
  const hostHome = fs.realpathSync.native(capturedHome);
  const hostRoot = fs.realpathSync.native(params.bundleRoot);
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!packageRoot) {
    throw new Error("Cannot locate the node runtime for filesystem isolation");
  }
  const sharedTempRoot = fs.realpathSync.native(
    resolvePreferredOpenClawTmpDir({ purpose: "worker" }),
  );
  if (
    [hostHome, hostRoot, packageRoot, sharedTempRoot].some((root) => isPathInside(workspace, root))
  ) {
    throw new Error("Worker workspace cannot contain node runtime or private storage");
  }
  const home = path.join(hostHome, "model-home");
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
  const readOnlyPaths = [
    path.dirname(params.entry),
    packageRoot,
    path.dirname(process.execPath),
    "/bin",
    "/usr",
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
  const temporaryRoot = fs.mkdtempSync(path.join(sharedTempRoot, "worker-"));
  const cleanup = () => removeTemporaryArtifacts(temporaryRoot, "Node worker scratch");
  const args = ["restrict-exec"];
  for (const value of readOnlyPaths) {
    args.push("--read-only", value);
  }
  for (const value of [workspace, home, temporaryRoot, "/dev/null"]) {
    args.push("--read-write", value);
  }
  args.push("--cwd", workspace);
  // Apply only after confinement: the trusted process owner must never use
  // a model-writable HOME or code cache.
  const env = {
    HOME: home,
    PATH: path.join(home, ".local", "bin") + path.delimiter + (params.env.PATH ?? ""),
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    OPENCLAW_INTERNAL_WORKER_TMPDIR: temporaryRoot,
    NODE_COMPILE_CACHE: path.join(temporaryRoot, "node-compile-cache"),
  };
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push("--", process.execPath, ...params.args);
  return { command: OPENSHELL_RESTRICT_EXEC, args, cleanup };
}
