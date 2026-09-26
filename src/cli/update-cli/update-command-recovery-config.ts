import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  getConfigFileWriteCapture,
  withConfigFileWriteCapture,
} from "../../config/write-capture.js";
import {
  mergeUpdateRunRecoveryCaptureState,
  type UpdateRecoveryBackupRef,
} from "../../infra/update-recovery-backup-contract.js";
import { canonicalEntryPath } from "../../infra/update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "../../infra/update-recovery-backup-verify.js";
import { mutateRun } from "../../infra/update-run-write.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
type Capture = {
  active: boolean;
  run: Run;
  runId: string;
  env: NodeJS.ProcessEnv;
  baseline?: {
    ref: UpdateRecoveryBackupRef;
    assertCurrent: () => void;
  };
};
const captures = new AsyncLocalStorage<Capture>();

/** Called only by the successful original baseline owner, after its durable receipt.
 * Writes preceding B do not belong to the mutable update's authored-byte suffix. */
export function bindOriginalUpdateConfigCapture(
  run: Run,
  ref: UpdateRecoveryBackupRef,
  assertCurrent: () => void,
): void {
  const capture = captures.getStore();
  if (!capture) {
    return;
  }
  assertCurrent();
  if (!capture.active || capture.run !== run || capture.runId !== run.runId || capture.baseline) {
    throw new Error("Config receipts lost their original baseline owner.");
  }
  capture.baseline = { ref: structuredClone(ref), assertCurrent };
  getConfigFileWriteCapture()!.clear();
}

/** Flush before stopped-C capture, never while its database writer is excluded.
 * Failure retains the exact suffix; no retry or new owner is manufactured. */
export async function persistOriginalUpdateConfigWrites(run: Run): Promise<void> {
  const capture = captures.getStore();
  const writes = getConfigFileWriteCapture();
  if (!capture || !writes?.size || !capture.baseline) {
    return;
  }
  const { baseline } = capture;
  const assertCurrent = () => {
    if (
      !capture.active ||
      capture.run !== run ||
      capture.runId !== run.runId ||
      !isDeepStrictEqual(run.recoveryBaseline, baseline.ref)
    ) {
      throw new Error("Config receipts changed their original recovery capture.");
    }
    baseline.assertCurrent();
  };
  assertCurrent();
  const observed = new Map(writes);
  const suffix = [...observed.values()]
    .map((entry) => Object.assign({}, entry, { path: canonicalEntryPath(entry.path) }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const verified = await prepareVerifiedBackup(baseline.ref, { env: capture.env });
  try {
    await verified.assertCurrent();
    assertCurrent();
    if (
      verified.manifest.runId !== capture.runId ||
      verified.manifest.generation?.kind !== "baseline" ||
      suffix.some((entry) => !verified.manifest.configPaths.includes(entry.path))
    ) {
      throw new Error("Config writes are outside their original baseline inventory.");
    }
    mutateRun(
      capture.runId,
      (record) => {
        assertCurrent();
        const recoveryCapture = record.origin.updateRecoveryCapture;
        if (recoveryCapture?.manifestSha256 !== baseline.ref.manifestSha256) {
          throw new Error("Config receipts lost their committed baseline row.");
        }
        const combined = new Map(recoveryCapture.configWrites.map((entry) => [entry.path, entry]));
        for (const entry of suffix) {
          const previous = combined.get(entry.path);
          combined.set(
            entry.path,
            previous
              ? {
                  ...entry,
                  beforeHash: previous.beforeHash,
                  contiguous:
                    previous.contiguous &&
                    entry.contiguous &&
                    previous.afterHash === entry.beforeHash,
                }
              : entry,
          );
        }
        record.origin.updateRecoveryCapture = mergeUpdateRunRecoveryCaptureState(record, {
          manifestSha256: baseline.ref.manifestSha256,
          configWrites: [...combined.values()].toSorted((left, right) =>
            left.path.localeCompare(right.path),
          ),
        });
      },
      { env: capture.env },
    );
    assertCurrent();
    if (
      writes.size !== observed.size ||
      [...observed].some(([key, entry]) => writes.get(key) !== entry)
    ) {
      throw new Error("Config writers changed during receipt publication; suffix retained.");
    }
    writes.clear();
  } finally {
    await verified.close();
  }
}

/** The same admitted command owns capture through execution and finalization.
 * Legacy invocations that never create B retain their existing behavior. */
async function withOriginalUpdateConfigCapture<T>(
  run: Run,
  operation: () => Promise<T>,
): Promise<T> {
  if (captures.getStore()) {
    throw new Error("An update config capture is already active.");
  }
  const capture: Capture = { active: true, run, runId: run.runId, env: { ...run.env } };
  return captures.run(capture, () =>
    withConfigFileWriteCapture(async () => {
      let outcome: { value: T } | { error: unknown };
      try {
        try {
          outcome = { value: await operation() };
        } catch (error) {
          outcome = { error };
        }
        try {
          await persistOriginalUpdateConfigWrites(run);
        } catch (error) {
          if ("error" in outcome) {
            throw new AggregateError(
              [outcome.error, error],
              "Update and config receipt settlement failed.",
              { cause: error },
            );
          }
          throw error;
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.value;
      } finally {
        capture.active = false;
      }
    }),
  );
}

export function withOriginalUpdateRecoveryCapture(
  opts: UpdateCommandOptions & { run: Run },
  recoveryState: UpdateCommandRecoveryState,
  operation: () => Promise<void>,
): Promise<void> {
  return withOriginalUpdateConfigCapture(opts.run, () =>
    withUpdateCommandRecoveryUnwind(opts, recoveryState, operation),
  );
}
