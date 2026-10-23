import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errors.js";
import { resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";

let compatibilitySurface: Promise<void> | undefined;

function assertUpdateCompatibilitySurface(): Promise<void> {
  return (compatibilitySurface ??= Promise.all([
    import("../../infra/update-immutable-activation.js"),
    import("../../infra/update-managed-service-handoff-current.js"),
    import("../../infra/update-recovery-baseline-capture.js"),
    import("../../infra/worker-native-lifecycle.js"),
  ]).then(([immutable, handoff, recovery, workers]) => {
    if (
      typeof immutable.activateImmutableUpdate !== "function" ||
      typeof immutable.recoverImmutableUpdate !== "function" ||
      typeof handoff.isCurrentManagedServiceUpdateHandoffProcess !== "function" ||
      typeof recovery.captureUpdateRecoveryBaseline !== "function" ||
      typeof workers.closeDefaultRetainedNativeWorkerSource !== "function"
    ) {
      throw new Error("Extended-stable update compatibility exports are unavailable.");
    }
  }));
}

async function isImmutableLayout(input: string): Promise<boolean> {
  const root = path.resolve(input);
  if (
    path.basename(path.dirname(root)) === "releases" &&
    /^[a-f0-9]{40}$/iu.test(path.basename(root))
  ) {
    return true;
  }
  const installation = path.basename(root) === "current" ? path.dirname(root) : root;
  try {
    const [current, releases] = await Promise.all([
      fs.lstat(path.join(installation, "current")),
      fs.lstat(path.join(installation, "releases")),
    ]);
    return current.isSymbolicLink() && releases.isDirectory();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

/** Preserve 2026.10.1's pre-mutation immutable-install boundary during downgrade. */
export async function tryRunImmutableUpdateCommand(opts: UpdateCommandOptions): Promise<boolean> {
  await assertUpdateCompatibilitySurface();
  const root = await resolveUpdateRoot(opts.sourceUpdate);
  if (!(await isImmutableLayout(root))) {
    return false;
  }
  throw new Error(
    "Immutable installations cannot be updated by this extended-stable release. Preserve the sealed generations and use an updater that supports immutable activation.",
  );
}
