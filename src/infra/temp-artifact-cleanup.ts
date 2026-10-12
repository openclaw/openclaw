import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";

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

async function isRetainedRuntimeMarker(marker: string): Promise<boolean> {
  if ((await fs.realpath(marker).catch(() => undefined)) !== marker) {
    return false;
  }
  const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  return isRecord(value) && value.name === "openclaw";
}

async function recognizesRetainedRuntime(directory: string, packageRoot: string): Promise<boolean> {
  const base = path.parse(packageRoot).root;
  const tree = path.join(directory, "tree", Buffer.from(base).toString("hex"));
  const projectedRoot = path.join(tree, path.relative(base, packageRoot));
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
  assertResourcesSettled?: () => void;
}): Promise<string[]> {
  const messages: string[] = [];
  // Native spelling matches the projection, registration, and marker realpaths
  // even when callers pass a Windows 8.3 or differently cased spelling.
  const packages = params.packageRoots.map(resolveIdentityPathViaExistingAncestorSync);
  const roots = new Set(
    [
      os.tmpdir(),
      ...(params.temporaryDirectories ?? []),
      ...packages.map((root) => path.dirname(root)),
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
          let marked = false;
          for (const packageRoot of packages) {
            if (await recognizesRetainedRuntime(directory, packageRoot)) {
              marked = true;
              break;
            }
          }
          if (!marked) {
            throw new Error("no recognized runtime marker; inspect it before manual cleanup");
          }
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
          const census = inspectOtherOpenClawProcesses();
          if ("error" in census) {
            throw new Error(census.error);
          }
          if (census.pids.length) {
            throw new Error(
              `other OpenClaw processes are still running (PIDs: ${census.pids.join(", ")}); let these holders finish, then rerun openclaw doctor --fix`,
            );
          }
          params.assertResourcesSettled?.();
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
