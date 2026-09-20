import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigPath } from "../config/config.js";
import { withConfigMutationLock } from "../config/mutate.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireDirectorySync } from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  updateRecoveryTerminalOutcomeSchema,
  type UpdateRecoveryConfigWrite,
  type UpdateRecoveryBackupRef,
} from "./update-recovery-backup-contract.js";
import { captureUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import {
  backupStore,
  digest,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";
import {
  assertManifestLocation,
  withRecoveryMetadata,
  MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
} from "./update-recovery-backup-metadata.js";
import { restorePreparedUpdateRecoveryBackup } from "./update-recovery-backup-restore.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";
import {
  persistUpdateRecoveryConfigWrites,
  withUpdateRecoveryConfigValidation,
  withUpdateRecoveryConfigWrites,
} from "./update-recovery-config-writes.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "./update-run-driver.js";
import { resolveUpdateRecoveryTerminalOutcome } from "./update-run-record.js";
const log = createSubsystemLogger("update/backup");
type Authority = { assertOwned: () => void };
type CreateOptions = Authority & {
  runId: string;
  installRoot: string;
  drivers?: UpdateRunDriver[];
  resumeFromDriver?: UpdateRunDriver;
};
const outcomeSchema = z
  .object({
    status: z.enum(["pending", "restored", "committed", "restore-failed"]),
    error: z.string().optional(),
  })
  .strict();
type Outcome = z.infer<typeof outcomeSchema>;
const recordedOutcomeSchema = updateRecoveryTerminalOutcomeSchema;

/** Capture all owned recovery inputs after the caller has stopped writers. */
export async function createUpdateRecoveryBackup(
  params: CreateOptions,
): Promise<UpdateRecoveryBackupRef> {
  return await withConfigMutationLock({}, async () => {
    const { getUpdateRun } = await import("./update-run-ledger.js");
    if (params.resumeFromDriver) {
      const { hasUpdateRecoveryForwardResolution } = await import("./update-recovery-forward.js");
      const { readProcessParentPidSync } = await import("./restart-stale-pids.js");
      const unresolved = [];
      for (const capture of await listBackups()) {
        if (!(await hasUpdateRecoveryForwardResolution(capture.ref))) {
          unresolved.push(capture);
        }
      }
      const existing = unresolved[0];
      if (existing && unresolved.length === 1) {
        const driver = params.resumeFromDriver;
        const assertContinuation = () => {
          params.assertOwned();
          const run = getUpdateRun(params.runId);
          const currentDriver = readUpdateRunDriver(driver.pid);
          // A shipped migrated worker adopts the run before its second Doctor.
          // Reuse B only through its live immediate predecessor, recorded both
          // in the original capture and in the same run's adoption history.
          const predecessor = run?.origin.previousDrivers?.find((owner) =>
            existing.manifest.drivers.some((captured) => sameUpdateRunDriver(captured, owner)),
          );
          const currentPredecessor = predecessor
            ? readUpdateRunDriver(readProcessParentPidSync(driver.pid) ?? 0)
            : undefined;
          const ownsCapturedDriver =
            existing.manifest.drivers.some((owner) => sameUpdateRunDriver(owner, driver)) ||
            (predecessor !== undefined &&
              currentPredecessor !== undefined &&
              sameUpdateRunDriver(currentPredecessor, predecessor));
          if (
            existing.manifest.runId !== params.runId ||
            existing.manifest.installRoot !== path.resolve(params.installRoot) ||
            existing.outcome.status !== "pending" ||
            existing.manifest.generation?.kind !== "baseline" ||
            !ownsCapturedDriver ||
            inspectUpdateRunDriver(existing.manifest.creator) !== "dead" ||
            !currentDriver ||
            !sameUpdateRunDriver(currentDriver, driver) ||
            run?.status !== "running" ||
            !run.origin.driver ||
            !sameUpdateRunDriver(run.origin.driver, driver) ||
            (run.origin.updateRecoveryCapture &&
              (run.origin.updateRecoveryCapture.manifestSha256 !== existing.ref.manifestSha256 ||
                run.origin.updateRecoveryCapture.status !== "pending" ||
                run.origin.updateRecoveryCapture.restored))
          ) {
            throw new Error(
              "Update capture cannot continue under this updater; its original recovery set remains retained. Inspect openclaw update status --json.",
            );
          }
        };
        // A second Doctor in the same live update uses B unchanged. It must not
        // recapture already-migrated state or adopt another/settled transaction.
        const assertNoSettlement = async () => {
          if (
            (await statOrMissing(path.join(existing.ref.directory, "candidate"))) ||
            (await statOrMissing(path.join(existing.ref.directory, "prepared")))
          ) {
            throw new Error(
              "Update capture cannot continue after recovery settlement began; all generations remain retained.",
            );
          }
        };
        assertContinuation();
        await assertNoSettlement();
        await verifyUpdateRecoveryBackup(existing.ref);
        await assertNoSettlement();
        assertContinuation();
        return existing.ref;
      }
    }
    await assertNoUnresolvedUpdateRecoveryBackup();
    params.assertOwned();
    if (!getUpdateRun(params.runId)) {
      throw new Error(
        "Update capture requires its existing admitted run; no state was bootstrapped. Inspect with openclaw update status --json.",
      );
    }
    const ref = await captureUpdateRecoveryBackup(params);
    await verifyUpdateRecoveryBackup(ref);
    await writeUpdateRecoveryBackupOutcome(ref, { status: "pending" }, params);
    return ref;
  });
}

/** Verify every recorded payload before any restore changes live state. */
export async function verifyUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
): Promise<UpdateRecoveryBackupManifest> {
  const prepared = await prepareVerifiedBackup(ref);
  try {
    return prepared.manifest;
  } finally {
    await prepared.close();
  }
}

/** Seal the stopped candidate once. A retry never replaces either source generation. */
export async function preserveUpdateRecoveryCandidate(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<UpdateRecoveryBackupRef> {
  return await withConfigMutationLock({}, async () => {
    const baseline = await prepareVerifiedBackup(ref);
    let preservationFailure: { error: unknown } | undefined;
    try {
      if (
        baseline.manifest.schemaVersion !== 2 ||
        baseline.manifest.generation?.kind !== "baseline"
      ) {
        throw new Error(
          `Legacy update recovery set is inspection-only: ${ref.manifestPath}. It has no lossless candidate/publication contract; no package or state replacement is permitted. Inspect openclaw update status --json.`,
        );
      }
      // Flush the active authored-byte suffix before sealing C: T must use the
      // same complete receipt chain, including writes from this parent scope.
      await persistUpdateRecoveryConfigWrites(ref, authority);
      await baseline.assertCurrent();
      authority.assertOwned();
      const directory = path.join(ref.directory, "candidate");
      let candidate: UpdateRecoveryBackupRef;
      if (await statOrMissing(directory)) {
        const source = await safeRoot(directory);
        let raw: Buffer;
        try {
          raw = (
            await source.read("manifest.json", {
              maxBytes: MAX_MANIFEST_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer;
        } catch (cause) {
          throw new Error(
            `Candidate preservation is incomplete at ${directory}; baseline and partial candidate retained. Do not overwrite or remove either generation. Inspect openclaw update status --json.`,
            { cause },
          );
        }
        candidate = {
          directory,
          manifestPath: path.join(directory, "manifest.json"),
          manifestSha256: digest(raw),
        };
      } else {
        candidate = await captureUpdateRecoveryBackup({
          ...authority,
          runId: baseline.manifest.runId,
          installRoot: baseline.manifest.installRoot,
          drivers: baseline.manifest.drivers,
          baseline: { ref, manifest: baseline.manifest },
        });
      }
      const manifest = await verifyUpdateRecoveryBackup(candidate);
      await baseline.assertCurrent();
      authority.assertOwned();
      if (
        manifest.generation?.kind !== "candidate" ||
        manifest.generation.baselineSha256 !== ref.manifestSha256
      ) {
        throw new Error(
          `Candidate generation belongs to another baseline: ${candidate.manifestPath}`,
        );
      }
      return candidate;
    } catch (error) {
      preservationFailure = { error };
      throw error;
    } finally {
      await baseline.close().catch((cleanupError: unknown) => {
        if (preservationFailure) {
          throw new AggregateError(
            [preservationFailure.error, cleanupError],
            `Candidate preservation failed and verification staging cleanup also failed. Baseline and candidate evidence remain retained at ${ref.manifestPath}.`,
            { cause: preservationFailure.error },
          );
        }
        throw cleanupError;
      });
    }
  });
}

/** Restore only a migration-owner-prepared generation; raw B is never a rollback plan. */
export async function restoreUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const candidate = await preserveUpdateRecoveryCandidate(ref, authority);
  const prepared = await prepareVerifiedBackup(ref);
  let restored = false;
  let restorationFailure: { error: unknown } | undefined;
  try {
    await withUpdateRecoveryConfigWrites(ref, authority, () =>
      withUpdateRecoveryConfigValidation(
        ref,
        prepared.manifest,
        authority,
        async (assertConfigCurrent) => {
          const { getUpdateRunAsync } = await import("./update-run-reader.js");
          const previousRun = await getUpdateRunAsync(prepared.manifest.runId);
          authority.assertOwned();
          if (
            !previousRun?.origin.updateRecoveryCapture ||
            previousRun.origin.updateRecoveryCapture.manifestSha256 !== ref.manifestSha256
          ) {
            throw new Error("Update recovery run ownership is missing before restoration.");
          }
          // Stopping writers proves custody, not ownership of their committed
          // writes. Never use the baseline as a prepared generation.
          const { assertUpdateRecoveryPublicationPrepared } =
            await import("./update-recovery-publication.js");
          await assertUpdateRecoveryPublicationPrepared(ref, candidate, authority);
          let restoreFailure: { error: unknown } | undefined;
          try {
            await restorePreparedUpdateRecoveryBackup(
              {
                ...prepared,
                assertCurrent: async () => {
                  await prepared.assertCurrent();
                  await assertConfigCurrent();
                },
              },
              authority,
            );
            restored = true;
          } catch (error) {
            restoreFailure = { error };
          }
          try {
            // The shared database snapshot predates these receipts and the failed run's settlement.
            const { getUpdateRun, recordUpdateRunRecoveryCapture, finishUpdateRun } =
              await import("./update-run-ledger.js");
            authority.assertOwned();
            const current = getUpdateRun(previousRun.runId);
            if (!current) {
              throw new Error("Update recovery run disappeared during restoration.");
            }
            const savedCapture = previousRun.origin.updateRecoveryCapture;
            const currentCapture = current.origin.updateRecoveryCapture;
            if (!currentCapture) {
              recordUpdateRunRecoveryCapture(
                previousRun.runId,
                savedCapture,
                authority.assertOwned,
              );
            } else if (!isDeepStrictEqual(currentCapture, savedCapture)) {
              throw new Error("Update recovery receipts changed during restoration.");
            }
            authority.assertOwned();
            if (previousRun.status !== "running" && current.status === "running") {
              finishUpdateRun(previousRun.runId, {
                status: previousRun.status,
                reason: previousRun.reason ?? undefined,
                after: previousRun.after,
                downtimeMs: previousRun.downtimeMs ?? undefined,
              });
            }
          } catch (error) {
            if (restoreFailure) {
              throw new AggregateError(
                [restoreFailure.error, error],
                `State restoration failed and update run receipts could not be recovered. Capture retained at ${ref.manifestPath}; run npx openclaw@latest doctor --fix.`,
                { cause: error },
              );
            }
            throw error;
          }
          if (restoreFailure) {
            throw restoreFailure.error;
          }
        },
      ),
    );
  } catch (error) {
    if (!restored) {
      restorationFailure = { error };
      throw error;
    }
    authority.assertOwned();
    log.warn(
      `State restored; config write receipts could not be completed for ${ref.manifestPath}: ${formatErrorMessage(error)}`,
    );
  } finally {
    await prepared.close().catch((error: unknown) => {
      if (!restored) {
        if (restorationFailure) {
          throw new AggregateError(
            [restorationFailure.error, error],
            `State restoration failed and temporary verification files could not be removed. Capture retained at ${ref.manifestPath}.`,
            { cause: restorationFailure.error },
          );
        }
        throw error;
      }
      authority.assertOwned();
      log.warn(
        `State restored; temporary verification files could not be removed for ${ref.manifestPath}: ${formatErrorMessage(error)}`,
      );
    });
  }
}

export async function writeUpdateRecoveryBackupOutcome(
  ref: UpdateRecoveryBackupRef,
  outcome: Outcome,
  authority: Authority,
): Promise<void> {
  const validated = outcomeSchema.parse(outcome);
  await withConfigMutationLock({ lockPath: resolveConfigPath() }, () =>
    withRecoveryMetadata(ref, authority, async ({ manifest, outcome: previous, pin }) => {
      if (validated.status === "pending" || validated.status === "restore-failed") {
        if (previous) {
          throw new Error("A terminal update capture outcome cannot be reopened.");
        }
        const { recordUpdateRunRecoveryCapture } = await import("./update-run-ledger.js");
        recordUpdateRunRecoveryCapture(
          manifest.runId,
          {
            manifestSha256: ref.manifestSha256,
            status: validated.status,
            error: validated.error?.slice(0, 4096),
          },
          authority.assertOwned,
        );
        return;
      }
      if (previous) {
        if (previous.status !== validated.status) {
          throw new Error("The write-once update capture outcome is already settled.");
        }
        return;
      }
      const next = recordedOutcomeSchema.parse({
        ...validated,
        manifestSha256: ref.manifestSha256,
      });
      const target = path.join(ref.directory, "outcome.json");
      const temporary = `${target}.${randomUUID()}`;
      try {
        const output = await fs.open(temporary, "wx", 0o600);
        try {
          await output.writeFile(`${JSON.stringify(next)}\n`);
          await output.sync();
        } finally {
          await output.close();
        }
        await pin.assertCurrent();
        authority.assertOwned();
        await fs.link(temporary, target);
        await fs.unlink(temporary);
        requireDirectorySync(await pin.sync(), "Update recovery outcome");
      } finally {
        await pin.assertCurrent();
        await fs.rm(temporary, { force: true });
      }
    }),
  );
}

export async function appendUpdateRecoveryConfigWrites(
  ref: UpdateRecoveryBackupRef,
  writes: readonly UpdateRecoveryConfigWrite[],
  authority: Authority,
): Promise<void> {
  await withRecoveryMetadata(ref, authority, async ({ manifest }) => {
    const unexpected = writes.find((entry) => !manifest.configPaths.includes(entry.path));
    if (unexpected) {
      throw new Error(
        `Config write ${unexpected.path} is outside the update backup inventory. Backup retained at ${ref.manifestPath}; run npx openclaw@latest doctor --fix after resolving ownership.`,
      );
    }
    const { recordUpdateRunRecoveryCapture } = await import("./update-run-ledger.js");
    recordUpdateRunRecoveryCapture(
      manifest.runId,
      {
        manifestSha256: ref.manifestSha256,
        configWrites: [...writes],
      },
      authority.assertOwned,
    );
  });
}

export async function readUpdateRecoveryConfigState(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<{ manifest: UpdateRecoveryBackupManifest; configWrites: UpdateRecoveryConfigWrite[] }> {
  return await withRecoveryMetadata(ref, authority, async ({ manifest }) => {
    const { getUpdateRunAsync } = await import("./update-run-reader.js");
    const capture = (await getUpdateRunAsync(manifest.runId))?.origin.updateRecoveryCapture;
    authority.assertOwned();
    if (!capture || capture.manifestSha256 !== ref.manifestSha256) {
      throw new Error(
        `Update capture ownership receipts are missing or changed: ${ref.manifestPath}. Inspect with openclaw update status --json; run npx openclaw@latest doctor --fix after resolving ownership.`,
      );
    }
    return { manifest, configWrites: capture.configWrites };
  });
}

async function listBackups(installRoot?: string): Promise<
  Array<{
    ref: UpdateRecoveryBackupRef;
    manifest: UpdateRecoveryBackupManifest;
    outcome: Outcome;
  }>
> {
  const result: Array<{
    ref: UpdateRecoveryBackupRef;
    manifest: UpdateRecoveryBackupManifest;
    outcome: Outcome;
  }> = [];
  const store = backupStore();
  if (!(await statOrMissing(store))) {
    return result;
  }
  const { UPDATE_CAPTURE_PRIVACY_MARKER } = await import("./update-capture-privacy-marker.js");
  const { getUpdateRunAsync } = await import("./update-run-reader.js");
  for (const captureId of await fs.readdir(store)) {
    if (captureId === UPDATE_CAPTURE_PRIVACY_MARKER) {
      continue;
    }
    const directory = path.join(store, captureId);
    const manifestPath = path.join(directory, "manifest.json");
    if (
      !(await statOrMissing(directory))?.isDirectory() ||
      !(await statOrMissing(manifestPath))?.isFile()
    ) {
      throw new Error(
        `Unresolved update capture ${directory} has incomplete publication. Inspection only: openclaw update status --json; npx openclaw@latest doctor --fix. Earlier captures are retained.`,
      );
    }
    const source = await safeRoot(directory);
    const raw = (
      await source.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer.toString("utf8");
    const manifest = parseUpdateRecoveryBackupManifest(raw);
    if (installRoot && manifest.installRoot !== path.resolve(installRoot)) {
      continue;
    }
    const ref = { directory, manifestPath, manifestSha256: digest(raw) };
    assertManifestLocation(ref, manifest);
    const terminalPath = path.join(directory, "outcome.json");
    let outcome: Outcome;
    if (await statOrMissing(terminalPath)) {
      const terminal = recordedOutcomeSchema.parse(
        JSON.parse(
          (
            await source.read("outcome.json", {
              maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer.toString("utf8"),
        ),
      );
      if (terminal.manifestSha256 !== ref.manifestSha256) {
        throw new Error(`Update recovery outcome refers to another manifest: ${manifestPath}`);
      }
      outcome = terminal;
    } else {
      const capture = (await getUpdateRunAsync(manifest.runId))?.origin.updateRecoveryCapture;
      if (capture && capture.manifestSha256 !== ref.manifestSha256) {
        throw new Error(
          `Update capture identity changed: ${manifestPath}. Inspect with openclaw update status --json; npx openclaw@latest doctor --fix.`,
        );
      }
      outcome = { status: capture?.status ?? "pending", error: capture?.error };
    }
    result.push({ ref, manifest, outcome });
  }
  return result.toSorted((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

/** A retained transaction must be resolved explicitly before another mutation. */
export async function assertNoUnresolvedUpdateRecoveryBackup(
  _params: { installRoot?: string } = {},
): Promise<void> {
  const { hasUpdateRecoveryForwardResolution } = await import("./update-recovery-forward.js");
  const captures = await listBackups();
  for (const existing of captures) {
    if (await hasUpdateRecoveryForwardResolution(existing.ref)) {
      continue;
    }
    throw new Error(
      `Update capture ${existing.ref.manifestPath} remains retained (${existing.outcome.status}); another protected mutation is refused. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
    );
  }
}

/** Backup-local pending markers cannot override the update's durable terminal result. */
export async function inspectUpdateRecoveryBackups(
  params: { installRoot?: string; forwardRepair?: true } = {},
) {
  const snapshots = await listBackups(params.installRoot);
  const { hasUpdateRecoveryForwardResolution } = await import("./update-recovery-forward.js");
  const forwardResolved = new Set<string>();
  for (const { ref } of snapshots) {
    if (await hasUpdateRecoveryForwardResolution(ref)) {
      forwardResolved.add(ref.manifestSha256);
    }
  }
  const { getUpdateRunAsync } = await import("./update-run-reader.js");
  return await Promise.all(
    snapshots.map(async ({ ref, manifest, outcome }) => {
      if (forwardResolved.has(ref.manifestSha256)) {
        return {
          ref,
          runId: manifest.runId,
          captureStatus: outcome.status,
          status: "forward-resolved" as const,
          terminalOutcome: undefined,
          nextAction: "openclaw update status --json",
          message: `Update recovery set ${ref.manifestPath}: current state repaired forward; failed history and all generations retained.`,
        };
      }
      let terminalOutcome: "committed" | "restored" | undefined;
      let ambiguity: string | undefined;
      try {
        const run = await getUpdateRunAsync(manifest.runId);
        terminalOutcome = resolveUpdateRecoveryTerminalOutcome(run, ref.manifestSha256);
        if (outcome.status === "committed" || outcome.status === "restored") {
          if (terminalOutcome && terminalOutcome !== outcome.status) {
            terminalOutcome = undefined;
            ambiguity = "capture and update terminal outcomes disagree";
          } else {
            terminalOutcome = outcome.status;
          }
        }
        if (
          run?.origin.updateRecoveryCapture?.doctorCompleted &&
          !terminalOutcome &&
          !(
            params.forwardRepair &&
            run.status === "failed" &&
            run.origin.updateRecoveryCapture.manifestSha256 === ref.manifestSha256
          )
        ) {
          ambiguity = "Doctor succeeded but its older updater has no complete runtime validation";
        }
        if (!terminalOutcome && !ambiguity && run?.status !== "failed") {
          ambiguity = run ? `update run is ${run.status}` : "no matching update run exists";
        }
      } catch (error) {
        ambiguity = `update outcome is unreadable: ${formatErrorMessage(error)}`;
      }
      if (!terminalOutcome && !ambiguity && snapshots.length - forwardResolved.size > 1) {
        ambiguity =
          "other recovery sets exist; restoring this set could discard newer database writes";
      }
      const status: "stale" | "ambiguous" | "unresolved" = terminalOutcome
        ? "stale"
        : ambiguity
          ? "ambiguous"
          : "unresolved";
      const nextAction =
        status === "unresolved"
          ? "npx openclaw@latest doctor --fix"
          : "openclaw update status --json";
      const reason = terminalOutcome
        ? `stale: its update already ${terminalOutcome === "committed" ? "succeeded" : "restored state"}`
        : (ambiguity ?? "unresolved after a failed update");
      return {
        ref,
        runId: manifest.runId,
        captureStatus: outcome.status,
        status,
        terminalOutcome,
        nextAction,
        message: `Update recovery set ${ref.manifestPath}: ${reason}. ${status === "unresolved" ? "Keep the Gateway stopped and run" : "Automatic restoration is refused; inspect with"} \`${nextAction}\`.${status === "ambiguous" ? " Resolve the recorded outcome before retrying `npx openclaw@latest doctor --fix`." : ""}`,
      };
    }),
  );
}

/** Publish only the matching run's durable outcome; a retained file alone cannot authorize it. */
export async function reconcileUpdateRecoveryBackupOutcome(
  inspection: Awaited<ReturnType<typeof inspectUpdateRecoveryBackups>>[number],
  authority: Authority,
): Promise<void> {
  const outcome = inspection.terminalOutcome;
  if (!outcome) {
    throw new Error(inspection.message);
  }
  const { getUpdateRun } = await import("./update-run-ledger.js");
  await writeUpdateRecoveryBackupOutcome(
    inspection.ref,
    { status: outcome, error: inspection.message },
    {
      assertOwned: () => {
        authority.assertOwned();
        if (
          resolveUpdateRecoveryTerminalOutcome(
            getUpdateRun(inspection.runId),
            inspection.ref.manifestSha256,
          ) !== outcome
        ) {
          throw new Error("Update terminal outcome changed during backup reconciliation.");
        }
      },
    },
  );
}

export async function findPendingUpdateRecoveryBackup(
  params: { installRoot?: string; warn?: (message: string) => void; forwardRepair?: true } = {},
): Promise<UpdateRecoveryBackupRef | null> {
  const warn = params.warn ?? ((message: string) => log.warn(message));
  const inspections = await inspectUpdateRecoveryBackups(params);
  for (const inspection of inspections) {
    warn(inspection.message);
    if (inspection.terminalOutcome) {
      try {
        await reconcileUpdateRecoveryBackupOutcome(inspection, { assertOwned() {} });
      } catch (error) {
        warn(
          `Stale set remains ineligible, but its outcome could not be recorded: ${formatErrorMessage(error)}`,
        );
      }
    }
  }
  const ambiguous = inspections.find((inspection) => inspection.status === "ambiguous");
  if (ambiguous) {
    throw new Error(ambiguous.message);
  }
  const pending = inspections.find((inspection) => inspection.status === "unresolved");
  if (!pending) {
    return null;
  }
  await verifyUpdateRecoveryBackup(pending.ref);
  return pending.ref;
}

/** The terminal lifecycle supplies fresh authority; this owner deletes only the verified set. */
export async function retireUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const { retireUpdateRecoveryBackupOwned } = await import("./update-recovery-retirement.js");
  return await withConfigMutationLock({ lockPath: resolveConfigPath() }, () =>
    retireUpdateRecoveryBackupOwned(ref, authority),
  );
}

export { inspectUpdateRecoveryRetirements } from "./update-recovery-retirement.js";

export {
  readUpdateRecoveryBackupManifest,
  readUpdateRecoveryBackupRef,
} from "./update-recovery-backup-metadata.js";

export { prepareUpdateRecoveryGeneration } from "./update-recovery-preparation.js";
