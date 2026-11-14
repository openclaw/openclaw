import path from "node:path";
import { statIfExists } from "../infra/path-existence.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { ProjectRegistryIdentity } from "./project-registry.types.js";

const log = createSubsystemLogger("projects/clone-history");

/** History recovery is operator-owned: an unshallow can occupy the checkout lease for minutes. */
export async function warnIfProjectCloneShallow(
  repoRoot: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    commonDir?: string;
    source?: ProjectRegistryIdentity["source"];
  },
): Promise<void> {
  if (options.source && options.source !== "cloned") {
    return;
  }
  try {
    if (
      !(await statIfExists(path.join(options.commonDir ?? path.join(repoRoot, ".git"), "shallow")))
    ) {
      return;
    }
    if (!options.source) {
      const context = captureOpenClawStateWorkerContext(options);
      const { executeOpenClawStateWorker } =
        await import("../state/openclaw-state-worker-store.js");
      if (
        !(await executeOpenClawStateWorker(context, {
          type: "projects.findRoot",
          input: { repoRoot, source: "cloned" },
        }))
      ) {
        return;
      }
    }
    log.warn(
      `Managed project clone ${repoRoot} has shallow history; continuing without repair. Run openclaw doctor --fix during a maintenance window to restore full history while retaining blob:none.`,
    );
  } catch (error) {
    // A diagnostic must not turn an otherwise usable checkout into a failed user turn.
    log.warn(
      `Could not inspect clone history at ${repoRoot}; continuing. Run openclaw doctor to diagnose.`,
      { error: String(error) },
    );
  }
}
