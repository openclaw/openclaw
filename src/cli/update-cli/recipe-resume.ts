import path from "node:path";
import { reconcileOriginalRunPackagePublication } from "../../infra/package-update-activation-original-run.js";
import { resumeUpgradeRecipeOriginalRun } from "../../infra/upgrade-recipes/recovery.js";
import { inspectOriginalRecipePackagePublication } from "./recipe-original-publication.js";
import { createRecipeOriginalRecoveryPorts } from "./recipe-recovery-ports.js";
import {
  prepareOriginalRecipePublication,
  resumeOriginalRecipeStaging,
} from "./recipe-resume-preparation.js";
import { continueInAuthenticatedTarget } from "./recipe-target-continuation.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** Resume the durable original pointer through existing native package and target owners only. */
export async function resumeRetainedRecipeUpdate(options: {
  installation: string;
  ledgerPath: string;
  runId: string;
  runnerEntryUrl: string;
}) {
  const recovery = await createRecipeOriginalRecoveryPorts(options);
  if (path.resolve(options.installation) !== recovery.retained.binding.installationKey) {
    throw new Error("Recipe resume differs from its original native installation selection.");
  }
  return withOwnedManagedUpdateEnv(recovery.env, () =>
    resumeUpgradeRecipeOriginalRun({
      runId: options.runId,
      ports: recovery.ports,
      continueRun: async ({ retained, fence }) => {
        recovery.bindNativeFence(fence);
        if (!(await recovery.hasPublication())) {
          await resumeOriginalRecipeStaging({
            retained,
            fence,
            recipe: recovery.recipe,
            env: recovery.env,
          });
          fence.assertCurrent();
        }
        const inspected = await inspectOriginalRecipePackagePublication({
          retained,
          recipe: recovery.recipe,
          assertCurrent: fence.assertCurrent,
        });
        const preparing = inspected.phase === "preparing" || inspected.phase === "prepared";
        if (preparing) {
          await prepareOriginalRecipePublication({
            retained,
            fence,
            recipe: recovery.recipe,
            env: recovery.env,
            candidateRoot: inspected.candidateRoot,
          });
          fence.assertCurrent();
        }
        await reconcileOriginalRunPackagePublication({
          retained,
          fence,
          operationId: inspected.operationId,
          expectedCandidate: inspected.expectedCandidate,
          ...(preparing ? { continuePreparation: true } : {}),
        });
        fence.assertCurrent();
        return continueInAuthenticatedTarget({
          recipe: recovery.recipe,
          env: recovery.env,
          ledgerPath: retained.ledgerAuthority.databasePath,
          fence,
        });
      },
    }),
  );
}
