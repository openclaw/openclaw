import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { resolveOrdinaryRealpathInWorker } from "../../infra/exec-realpath-worker.js";
import { canAccess } from "../../infra/path-existence.js";
import { resolveSessionFilePathCoreSteps } from "./paths.js";

/** Async I/O uses the same path policy without adding worker dependencies to sync callers. */
export async function resolveSessionFilePathCoreAsync(
  ...args: Parameters<typeof resolveSessionFilePathCoreSteps>
): Promise<string> {
  const steps = resolveSessionFilePathCoreSteps(...args);
  let step = steps.next();
  while (!step.done) {
    const probe = step.value;
    step = steps.next(
      probe.kind === "realpath"
        ? await resolveOrdinaryRealpathInWorker(probe.path, getFsSafeNativeConfig().mode)
        : (await canAccess(probe.path))
          ? probe.path
          : undefined,
    );
  }
  return step.value;
}
