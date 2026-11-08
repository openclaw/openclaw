import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withProjectCheckoutLifecycle } from "./project-checkout.js";
import { ensureProjectCloneHistory, hasShallowProjectHistory } from "./project-clone-shape.js";

/** Preparation passes the canonical base, before acquiring any source checkout lease. */
export async function ensureManagedProjectCloneHistory(
  { repoRoot, commonDir }: { repoRoot: string; commonDir: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
): Promise<void> {
  if (!(await hasShallowProjectHistory(commonDir))) {
    return;
  }
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  await withProjectCheckoutLifecycle(
    repoRoot,
    { path: context.admission.databasePath, env, signal: options.signal },
    async (lease) => {
      const assertCurrent = () => {
        context.admission.assertCurrent();
        lease.assertCurrent();
        options.assertCurrent?.();
      };
      const { runWithOpenClawStateLeaseWorker } =
        await import("../state/openclaw-state-lease-worker-operation.js");
      await runWithOpenClawStateLeaseWorker(lease, context, async (scope) => {
        const project = await scope.execute({
          type: "projects.findRoot",
          input: { repoRoot, source: "cloned" },
        });
        assertCurrent();
        if (project) {
          await ensureProjectCloneHistory(project, {
            env,
            signal: lease.signal,
            assertCurrent,
          });
        }
      });
    },
  );
}
