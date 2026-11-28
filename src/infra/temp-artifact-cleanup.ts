import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./path-existence.js";
import { isPathInside } from "./path-guards.js";

const log = createSubsystemLogger("infra:temp-artifacts");
const retainedRuntimes = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedUpdateRuntimes"),
  () => new Set<string>(),
);

/** Registration lasts through worker settlement, including failed update reporting. */
export function registerRetainedUpdateRuntime(directory: string): () => void {
  retainedRuntimes.add(directory);
  return () => void retainedRuntimes.delete(directory);
}

export function reportRetainedUpdateRuntime(directory: string, reason: string): string {
  const message = `Runtime retained at ${directory}: ${reason}`;
  try {
    log.warn(message);
  } catch {
    // The caller still records the warning.
  }
  return message;
}

/** Placement and discovery share the climb outside the enclosing module owner. */
export function resolveRetainedUpdateRuntimeParents(
  packageRoot: string,
  mutationRoots: readonly string[] = [],
): string[] {
  const parts = packageRoot.split(path.sep);
  const modules = parts.indexOf("node_modules");
  const boundaries = [
    parts.slice(0, modules >= 0 ? modules + 1 : parts.length).join(path.sep),
    ...mutationRoots,
  ];
  let parent = path.dirname(packageRoot);
  const parents = [parent];
  while (boundaries.some((root) => isPathInside(root, parent))) {
    const ancestor = path.dirname(parent);
    if (ancestor === parent) {
      break;
    }
    parent = ancestor;
    parents.push(parent);
  }
  return parents;
}

const retainedRuntimeOwnerFile = "owner.json";

/** PIDs name a process only inside the namespace that recorded them. */
async function readPidNamespace(): Promise<string | null> {
  return process.platform === "linux"
    ? await fs.readlink("/proc/self/ns/pid").catch(() => null)
    : null;
}

/**
 * Only the update command creates a runtime, and it loads code from it until it
 * exits. Its recorded identity marks the directory for any installation and
 * decides custody without guessing which host processes might be that updater.
 */
export async function recordRetainedUpdateRuntimeOwner(directory: string): Promise<void> {
  await fs.writeFile(
    path.join(directory, retainedRuntimeOwnerFile),
    JSON.stringify({
      name: "openclaw",
      pid: process.pid,
      startTime: getFileLockProcessStartTime(process.pid),
      pidNamespace: await readPidNamespace(),
    }),
    { mode: 0o600, flag: "wx" },
  );
}

/** Runtimes from builds that recorded no owner return undefined. */
async function readRetainedRuntimeOwner(directory: string) {
  const file = path.join(directory, retainedRuntimeOwnerFile);
  if ((await fs.realpath(file).catch(() => undefined)) !== file) {
    return undefined;
  }
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (
    !isRecord(value) ||
    value.name !== "openclaw" ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    startTime: typeof value.startTime === "number" ? value.startTime : null,
    pidNamespace: typeof value.pidNamespace === "string" ? value.pidNamespace : null,
  };
}

async function isRetainedRuntimeMarker(marker: string): Promise<boolean> {
  if ((await fs.realpath(marker).catch(() => undefined)) !== marker) {
    return false;
  }
  const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  return isRecord(value) && value.name === "openclaw";
}

function projectRetainedSource(directory: string, source: string): string {
  const base = path.parse(source).root;
  return path.join(
    directory,
    "tree",
    Buffer.from(base).toString("hex"),
    path.relative(base, source),
  );
}

const retainedFileList = "retained-files.json";
const shippedRuntimeEntries = new Set([retainedFileList, "tree", "update-native-gate.mjs"]);

/**
 * Updaters through 2026.11.10 record no owner, and their projection encodes the
 * installation they ran from, which pnpm global installs and Git release folders
 * replace with a new path. Their own file list begins with the retained
 * package.json, so the runtime still proves what it holds after that move.
 */
async function recognizesShippedRuntime(directory: string): Promise<boolean> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    entries.length !== shippedRuntimeEntries.size ||
    !entries.every(
      (entry) =>
        shippedRuntimeEntries.has(entry.name) &&
        (entry.name === "tree" ? entry.isDirectory() : entry.isFile()),
    )
  ) {
    return false;
  }
  // The list holds every retained path (tens of MB); only its first entry is needed.
  const handle = await fs.open(path.join(directory, retainedFileList), "r");
  let head: string;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  const first = /^\[("(?:[^"\\]|\\.)*")/u.exec(head)?.[1];
  const manifest: unknown = first ? JSON.parse(first) : undefined;
  return (
    typeof manifest === "string" &&
    path.isAbsolute(manifest) &&
    path.normalize(manifest) === manifest &&
    path.basename(manifest) === "package.json" &&
    (await isRetainedRuntimeMarker(projectRetainedSource(directory, manifest)))
  );
}

async function recognizesRetainedRuntime(directory: string, packageRoot: string): Promise<boolean> {
  const projectedRoot = projectRetainedSource(directory, packageRoot);
  if (await isRetainedRuntimeMarker(path.join(projectedRoot, "package.json"))) {
    return true;
  }
  // Shipped projections encode the old source path, not the currently installed
  // pnpm version. Search only sibling package versions in that same projected store.
  const modules = path.dirname(projectedRoot);
  const version = path.dirname(modules);
  const store = path.dirname(version);
  if (
    path.basename(projectedRoot) !== "openclaw" ||
    path.basename(modules) !== "node_modules" ||
    !path.basename(version).startsWith("openclaw@") ||
    path.basename(store) !== ".pnpm" ||
    (await fs.realpath(store).catch(() => undefined)) !== store
  ) {
    return false;
  }
  let inspected = 0;
  for await (const entry of await fs.opendir(store)) {
    // A normal dependency store can contain well over a thousand entries.
    if (++inspected > 4096) {
      throw new Error(
        "retained pnpm version inventory exceeds the bounded lookup; inspect it before manual cleanup",
      );
    }
    if (
      entry.isDirectory() &&
      entry.name.startsWith("openclaw@") &&
      (await isRetainedRuntimeMarker(
        path.join(store, entry.name, "node_modules/openclaw/package.json"),
      ))
    ) {
      return true;
    }
  }
  return false;
}

/** Marked updater projections are disposable; live owners and maintenance fence reclamation. */
export async function maintainRetainedUpdateRuntimes(params: {
  packageRoots: readonly string[];
  temporaryDirectories?: readonly string[];
  repair: boolean;
  assertCurrent: () => void;
  assertResourcesSettled?: (directory: string) => void;
  /** Called for each runtime an updater created, before any removal attempt. */
  onRecognized?: (directory: string) => void;
}): Promise<string[]> {
  const messages: string[] = [];
  // Native spelling matches the projection, registration, and marker realpaths
  // even when callers pass a Windows 8.3 or differently cased spelling.
  const packages = params.packageRoots.map(resolveIdentityPathViaExistingAncestorSync);
  const roots = new Set(
    [
      os.tmpdir(),
      ...(params.temporaryDirectories ?? []),
      ...packages.flatMap((root) => resolveRetainedUpdateRuntimeParents(root)),
    ].map(resolveIdentityPathViaExistingAncestorSync),
  );
  for (const parent of roots) {
    try {
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!/^openclaw-update-runtime-[A-Za-z0-9]{6}$/u.test(entry.name)) {
          continue;
        }
        const directory = path.join(parent, entry.name);
        try {
          const before = await fs.lstat(directory);
          if (!before.isDirectory() || (process.getuid && before.uid !== process.getuid())) {
            throw new Error("directory ownership is unknown; inspect it before manual cleanup");
          }
          if (retainedRuntimes.has(directory)) {
            throw new Error("the creating update still owns this runtime");
          }
          const owner = await readRetainedRuntimeOwner(directory);
          let marked = owner !== undefined;
          for (const packageRoot of marked ? [] : packages) {
            if (await recognizesRetainedRuntime(directory, packageRoot)) {
              marked = true;
              break;
            }
          }
          marked ||= await recognizesShippedRuntime(directory);
          if (!marked) {
            throw new Error(
              "it does not match a runtime an OpenClaw updater created, so it is kept",
            );
          }
          params.onRecognized?.(directory);
          if (!params.repair) {
            messages.push(
              `Runtime retained at ${directory}: run \`openclaw doctor --fix\` after its workers stop`,
            );
            continue;
          }
          const { inspectOtherOpenClawProcesses } = await import("./openclaw-process-census.js");
          const current = await fs.lstat(directory);
          if (
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            current.ctimeMs !== before.ctimeMs ||
            retainedRuntimes.has(directory)
          ) {
            throw new Error("directory identity or custody changed");
          }
          params.assertCurrent();
          let creatorExited = false;
          if (owner && owner.pidNamespace === (await readPidNamespace())) {
            const startTime = getFileLockProcessStartTime(owner.pid);
            // An exited updater that its parent has not reaped still has a start time.
            const dead = isPidDefinitelyDead(owner.pid);
            // This process's registration above already settled its own runtimes.
            if (
              owner.pid !== process.pid &&
              !dead &&
              startTime !== null &&
              startTime === owner.startTime
            ) {
              throw new Error(`the creating update (PID ${owner.pid}) is still running`);
            }
            // Accepted edge: a reboot that reuses both the PID and its start time.
            creatorExited =
              owner.pid === process.pid || dead || (startTime !== null && owner.startTime !== null);
          }
          const census = inspectOtherOpenClawProcesses(directory, { creatorExited });
          if ("error" in census) {
            throw new Error(census.error);
          }
          for (const warning of census.warnings ?? []) {
            if (!messages.includes(warning)) {
              messages.push(warning);
            }
          }
          if (census.pids.length) {
            throw new Error(
              `other OpenClaw processes are still running (PIDs: ${census.pids.join(", ")}); let these holders finish, then rerun openclaw doctor --fix`,
            );
          }
          params.assertResourcesSettled?.(directory);
          params.assertCurrent();
          let failure: string | undefined;
          await removeTemporaryArtifacts(directory, "Updater runtime", (error) => {
            failure = `cleanup failed: ${formatErrorMessage(error)}`;
          });
          messages.push(
            failure
              ? reportRetainedUpdateRuntime(directory, failure)
              : `Removed abandoned updater runtime: ${directory}`,
          );
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            messages.push(reportRetainedUpdateRuntime(directory, formatErrorMessage(error)));
          }
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        messages.push(`Cannot inspect updater runtimes in ${parent}: ${formatErrorMessage(error)}`);
      }
    }
  }
  return messages;
}

// Only disposable filesystem artifacts are advisory. Call after resource release;
// failed deletion must preserve the primary result, including cancellation/timeouts.
export function removeTemporaryArtifacts(
  directory: string,
  owner: string,
  onError: (error: unknown) => void = (error) =>
    log.warn(
      truncateUtf16Safe(
        formatErrorMessage(
          `${owner} cleanup failed; files may remain in ${directory}. After the worker or session stops, check permissions and remove the retained directory: ${formatErrorMessage(error)}`,
        ),
        1_024,
      ),
    ),
): Promise<void> {
  return runBestEffortCleanup({
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    onError,
  });
}
