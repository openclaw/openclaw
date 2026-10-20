import { isDeepStrictEqual } from "node:util";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import {
  finishInterruptedUpdatePreview,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord, UpdateRunStep } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { defaultRuntime } from "../../runtime.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withMutableUpdateSignals } from "./update-command-mutable-signals.js";

// Identity in this map is minted only for a new local preview, never reconstructed
// from a run ID, process absence, or another invocation's diagnostic history.
const previewAdmissions = new WeakMap<
  object,
  { record: UpdateRunRecord; env: NodeJS.ProcessEnv; active?: boolean }
>();

/** Advance preview custody only across this owner's committed target writes. */
export function recordUpdateCommandTarget(
  run: UpdateCommandOptions["run"],
  patch: { target?: UpdateRunRecord["target"]; step?: UpdateRunStep },
): void {
  if (!run) {
    return;
  }
  let before: UpdateRunRecord | undefined;
  const committed = recordUpdateRunPhase(
    run.runId,
    "requested",
    patch,
    { env: run.env },
    (record) => {
      before = record;
    },
  );
  const admission = previewAdmissions.get(run);
  if (admission && isDeepStrictEqual(before, admission.record)) {
    admission.record = committed;
  }
}

export function admitUpdatePreviewSignalRun(
  run: NonNullable<UpdateCommandOptions["run"]>,
  record: UpdateRunRecord,
  env: NodeJS.ProcessEnv,
): void {
  previewAdmissions.set(run, { record, env: { ...env } });
}

/** Own diagnostics only for this freshly admitted invocation's lexical lifetime. */
export async function withUpdatePreviewSignals<T>(
  opts: UpdateCommandOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const admission = opts.dryRun === true && opts.run ? previewAdmissions.get(opts.run) : undefined;
  if (!admission || !opts.run || admission.active) {
    return await withMutableUpdateSignals(opts, operation);
  }
  admission.active = true;
  const { env } = admission;
  let interrupted = false;
  let shutdown: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const settlePreview = async () => {
    if (
      !interrupted ||
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
      process.env[POST_CORE_UPDATE_ENV] === "1"
    ) {
      return;
    }
    // Missing/displaced canonical state, pending recovery, or a changed row is
    // not permission to open a writable runtime or dispose of another owner.
    try {
      await assertUpdateRecoveryAdmission({ env });
      if (!isDeepStrictEqual(getUpdateRun(admission.record.runId, { env }), admission.record)) {
        return;
      }
      finishInterruptedUpdatePreview(admission.record, { env });
    } catch {
      defaultRuntime.error("Preview interruption could not be recorded; history remains pending.");
    }
  };
  const finishOwnedCleanup = () => (cleanup ??= settlePreview());
  const unregister = registerSignalExitBarrier(finishOwnedCleanup);
  const onSignal = (code: number) => {
    interrupted = true;
    shutdown ??= waitForSignalExitBarriers(code === 143 ? "SIGTERM" : "SIGINT")
      .catch(() => {
        defaultRuntime.error(
          "Preview interruption could not be recorded; history remains pending.",
        );
      })
      .finally(() => {
        process.exitCode = code;
      });
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await operation();
  } finally {
    try {
      // The global drain includes this command's own completion gate. Settle only
      // our preview here; the outer CLI finalizer joins the global drain afterward.
      await finishOwnedCleanup();
    } finally {
      previewAdmissions.delete(opts.run);
      const removeSignalHandlers = () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
      // Repeated signals stay with the accepted drain after lexical custody closes.
      if (shutdown) {
        void shutdown.then(removeSignalHandlers, removeSignalHandlers);
      } else {
        removeSignalHandlers();
      }
      unregister();
    }
  }
}
