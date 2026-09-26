import { isDeepStrictEqual } from "node:util";
import {
  mergeUpdateRunRecoveryCaptureState,
  type UpdateRecoveryBackupRef,
} from "../../infra/update-recovery-backup-contract.js";
import { captureUpdateRecoveryBackup } from "../../infra/update-recovery-backup-create.js";
import { prepareVerifiedBackup } from "../../infra/update-recovery-backup-verify.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { mutateRun } from "../../infra/update-run-write.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  captureUpdateCommandExecutorCurrentStores,
  captureUpdateCommandRecoveryGenerationAuthority,
} from "./update-command-executor.js";
import { bindOriginalUpdateConfigCapture } from "./update-command-recovery-config.js";
import { withUpdateRecoverySourceCustody } from "./update-command-recovery-custody.js";

/** Capture B in the original selected invocation after stop and before mutation.
 * Unselected released drivers retain their existing update path; a selected
 * original must not silently downgrade when its capture or authority fails. */
export async function captureOriginalUpdateRecoveryBaseline(params: {
  opts: UpdateCommandOptions;
  env: NodeJS.ProcessEnv;
  installRoot: string;
  assertCallerCurrent: () => void;
}): Promise<UpdateRecoveryBackupRef | undefined> {
  const { opts } = params;
  const run = opts.run;
  const executor = run?.executorFence;
  if (!run || !executor) {
    throw new Error("Recovery baseline requires its admitted update executor.");
  }
  const selection = captureUpdateCommandExecutorCurrentStores(executor, run.runId);
  if (!selection) {
    return undefined;
  }
  const assertOriginal = captureUpdateCommandRecoveryGenerationAuthority(executor, run.runId);
  const env = { ...params.env };
  const ledgerEnv = { ...run.env };
  const runId = run.runId;
  const installRoot = params.installRoot;
  const assertCaller = params.assertCallerCurrent.bind(params);
  const assertCurrent = () => {
    assertCaller();
    assertOriginal();
    if (
      opts.run !== run ||
      run.executorFence !== executor ||
      run.runId !== runId ||
      resolveOpenClawStateSqlitePath(env) !== selection.selection.state.databasePath
    ) {
      throw new Error("Recovery baseline changed its original run or selected state.");
    }
  };
  const assertCaptureCurrent = () => {
    assertCurrent();
    const current = captureUpdateCommandExecutorCurrentStores(executor, runId);
    if (installRoot !== selection.selection.installation.path) {
      throw new Error(
        "Update initial store admission refused: effective installation or store selectors diverged",
      );
    }
    // The original provider rechecks all physical identities; this comparison
    // rejects a successor selection, rather than manufacturing a fresh baseline.
    if (!isDeepStrictEqual(current, selection)) {
      throw new Error("Recovery baseline changed its selected physical stores.");
    }
  };
  assertCaptureCurrent();
  const original = getUpdateRun(runId, { env: ledgerEnv });
  if (!original || original.status !== "running" || original.origin.updateRecoveryCapture) {
    throw new Error("Recovery baseline requires an uncaptured, running original update.");
  }
  const ref = await withUpdateRecoverySourceCustody(
    { runId, installRoot, env, assertOwned: assertCaptureCurrent },
    async ({ assertCurrent: assertCapture }) => {
      const captured = await captureUpdateRecoveryBackup({
        runId,
        installRoot,
        env,
        assertOwned: assertCapture,
      });
      const verified = await prepareVerifiedBackup(captured, { env });
      try {
        await verified.assertCurrent();
        assertCapture();
        return Object.freeze({ ...captured });
      } finally {
        await verified.close();
      }
    },
  );
  assertCaptureCurrent();
  // The admitted ledger owner rechecks the row inside the committing transaction.
  // A missing/finished/substituted run never manufactures a new recovery owner.
  mutateRun(
    runId,
    (record) => {
      assertCaptureCurrent();
      if (
        record.status !== "running" ||
        record.createdAtMs !== original.createdAtMs ||
        record.origin.updateRecoveryCapture
      ) {
        throw new Error("Recovery run changed before baseline receipt publication.");
      }
      record.origin.updateRecoveryCapture = mergeUpdateRunRecoveryCaptureState(record, {
        manifestSha256: ref.manifestSha256,
        status: "pending",
        configWrites: [],
      });
    },
    { env: ledgerEnv },
  );
  assertCaptureCurrent();
  bindOriginalUpdateConfigCapture(run, ref, assertCurrent);
  return ref;
}
