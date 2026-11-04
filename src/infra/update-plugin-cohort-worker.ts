import {
  captureUpdateCommandExecutorAuthority,
  withDelegatedUpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import type { DecodedUpdatePluginCohortSettlementInput } from "../cli/update-cli/update-command-migrated-input.js";
import type {
  UpdatePluginCohortCommitInput,
  UpdatePluginCohortSettlementResult,
} from "../cli/update-cli/update-command-migrated-types.js";
import { VERSION, resolveRuntimeServiceBuildId } from "../version.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { readPackageVersion } from "./package-json.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";
import { loadPluginCohortRecovery } from "./update-run-recovery-store.js";
import { pluginCohortRecoveryMatchesSource } from "./update-run-recovery.js";

// Operations run only inside the existing executable worker. Its outer owner
// retains stdin bounds, native/process cleanup and result publication ordering.
export async function commitReadyUpdatePluginCohort(
  input: UpdatePluginCohortCommitInput,
): Promise<UpdatePluginCohortSettlementResult> {
  const executingRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!executingRoot || process.env[UPDATE_RUN_ID_ENV] !== input.runId) {
    throw new Error("Plugin cohort commit does not match its installed runtime and run.");
  }
  const result = await withUpdateCommandExecutor(input.runId, async (executor) => {
    // The foreground helper has joined and released custody before successor startup.
    // A still-live helper or another updater refuses this ordinary native claim.
    const fence = await executor.enter(input.installKey);
    const { withUpdateDatabaseEngine } =
      await import("../cli/update-cli/update-command-database-engine.js");
    fence.assertCurrent();
    return await withUpdateDatabaseEngine(process.env, async () => {
      await assertUpdateRecoveryAdmission({
        env: process.env,
        pluginCohort: { runId: input.runId, fence },
      });
      const pair = loadPluginCohortRecovery(input.runId, {
        env: process.env,
        allowNativeRead: true,
      });
      const authority = captureUpdateCommandExecutorAuthority(fence, input.runId);
      if (
        !pair ||
        pair.cohort.transactionId !== input.transactionId ||
        pair.cohort.installKey !== input.installKey ||
        authority.installKey !== pair.cohort.installKey ||
        !pluginCohortRecoveryMatchesSource(pair, { env: process.env }) ||
        resolveUpdateInstallRoot(executingRoot) !==
          resolveUpdateInstallRoot(pair.reservation.to.root)
      ) {
        throw new Error("Plugin cohort commit does not match its retained intent and source.");
      }
      const [version, buildId] = await Promise.all([
        readPackageVersion(executingRoot),
        readBuiltGatewayBuildId(executingRoot),
      ]);
      fence.assertCurrent();
      if (
        VERSION !== pair.reservation.to.version ||
        version !== pair.reservation.to.version ||
        resolveRuntimeServiceBuildId() !== pair.reservation.to.buildId ||
        (buildId ?? null) !== pair.reservation.to.buildId
      ) {
        throw new Error(
          "Plugin cohort commit does not match the running candidate version and build.",
        );
      }
      const { settleUpdatePluginCohort } = await import("../plugins/update-cohort-recovery.js");
      fence.assertCurrent();
      const settled = await settleUpdatePluginCohort({
        runId: input.runId,
        action: "commit",
        env: process.env,
        fence,
      });
      fence.assertCurrent();
      return { runId: input.runId, transactionId: input.transactionId, ...settled };
    });
  });
  return result;
}

export async function settleDelegatedUpdatePluginCohort(
  input: DecodedUpdatePluginCohortSettlementInput,
): Promise<UpdatePluginCohortSettlementResult> {
  const executingRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!input.executor || !executingRoot || process.env[UPDATE_RUN_ID_ENV] !== input.runId) {
    throw new Error(
      "Plugin cohort settlement does not match its delegated run and installed runtime.",
    );
  }
  const result = await withDelegatedUpdateCommandExecutor(
    input.executor,
    input.runId,
    executingRoot,
    async (fence) => {
      const { withUpdateDatabaseEngine } =
        await import("../cli/update-cli/update-command-database-engine.js");
      fence.assertCurrent();
      return await withUpdateDatabaseEngine(process.env, async () => {
        const authority = captureUpdateCommandExecutorAuthority(fence, input.runId);
        const pair = loadPluginCohortRecovery(input.runId, {
          env: process.env,
          allowNativeRead: true,
        });
        if (
          !pair ||
          pair.cohort.transactionId !== input.transactionId ||
          pair.cohort.installKey !== authority.installKey ||
          !pluginCohortRecoveryMatchesSource(pair, { env: process.env })
        ) {
          throw new Error(
            "Plugin cohort settlement does not match its retained intent and source.",
          );
        }
        const { settleUpdatePluginCohort } = await import("../plugins/update-cohort-recovery.js");
        fence.assertCurrent();
        const settled = await settleUpdatePluginCohort({
          runId: input.runId,
          action: "rollback",
          env: process.env,
          fence,
        });
        fence.assertCurrent();
        return { runId: input.runId, transactionId: input.transactionId, ...settled };
      });
    },
  );
  return result;
}
