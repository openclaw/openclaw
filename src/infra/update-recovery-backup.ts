import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigPath } from "../config/config.js";
import { withConfigMutationLock } from "../config/mutate.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { pinDirectory, requireDirectorySync, sha256File } from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import {
  updateRecoveryBackupRefSchema,
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
import {
  withUpdateRecoveryConfigValidation,
  withUpdateRecoveryConfigWrites,
} from "./update-recovery-config-writes.js";
import type { UpdateRunDriver } from "./update-run-driver.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const log = createSubsystemLogger("update/backup");
type Authority = { assertOwned: () => void };
type CreateOptions = Authority & {
  runId: string;
  installRoot: string;
  drivers?: UpdateRunDriver[];
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
    await assertNoUnresolvedUpdateRecoveryBackup();
    const { getUpdateRun } = await import("./update-run-ledger.js");
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

async function prepareVerifiedBackup(ref: UpdateRecoveryBackupRef) {
  updateRecoveryBackupRefSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  if (!(await fs.lstat(ref.directory)).isDirectory()) {
    throw new Error("Update recovery backup is not a directory.");
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const directoryPin = await pinDirectory(ref.directory);
  let staging: string | undefined;
  const close = async () => {
    try {
      await directoryPin.assertCurrent();
      if (staging) {
        await fs.rm(staging, { recursive: true });
      }
    } finally {
      await directoryPin.close();
    }
  };
  try {
    const sourceRoot = await safeRoot(ref.directory);
    const raw = (
      await sourceRoot.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer.toString("utf8");
    if (digest(raw) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest hash mismatch.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(raw);
    assertManifestLocation(ref, manifest);
    staging = await createPrivateSqliteTempDirectory(ref.directory, ".verify-");
    const payloads = new Map<string, string>();
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      await directoryPin.assertCurrent();
      const source = await sourceRoot.open(entry.archivePath, {
        symlinks: "reject",
        hardlinks: "reject",
      });
      const targetPath = path.join(staging, path.basename(entry.archivePath));
      const target = await fs.open(targetPath, "wx+", 0o600);
      try {
        const before = await source.handle.stat({ bigint: true });
        await copyFileHandle(source.handle, target, {
          noProgressMessage: "Update recovery staging copy made no progress.",
        });
        const actual = await sha256File(target);
        if (
          !sameFileMutationFingerprint(before, await source.handle.stat({ bigint: true })) ||
          actual.bytes !== entry.size ||
          actual.digest !== entry.sha256
        ) {
          throw new Error(`Update recovery payload hash or size mismatch: ${entry.archivePath}`);
        }
        await target.sync();
      } finally {
        await target.close();
        await source.handle.close();
      }
      if (entry.sqlite) {
        const database = openNodeSqliteDatabase(targetPath, {
          readOnly: true,
          allowExtension: true,
        });
        try {
          await loadSqliteVecExtension({ db: database });
          assertSqliteIntegrity(database, targetPath);
        } finally {
          database.close();
        }
      }
      payloads.set(entry.archivePath, targetPath);
    }
    await directoryPin.assertCurrent();
    return { manifest, payloads, close, assertCurrent: () => directoryPin.assertCurrent() };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Restore captured files and declared database directories, preserving unrelated paths. */
export async function restoreUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const prepared = await prepareVerifiedBackup(ref);
  let restored = false;
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
      throw error;
    }
    authority.assertOwned();
    log.warn(
      `State restored; config write receipts could not be completed for ${ref.manifestPath}: ${formatErrorMessage(error)}`,
    );
  } finally {
    await prepared.close().catch((error: unknown) => {
      if (!restored) {
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
  const existing = (await listBackups())[0];
  if (existing) {
    throw new Error(
      `Update capture ${existing.ref.manifestPath} remains retained (${existing.outcome.status}); another protected mutation is refused. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
    );
  }
}

function settledRunOutcome(
  run: UpdateRunRecord | undefined,
  manifestSha256: string,
): "committed" | "restored" | undefined {
  if (run?.status === "succeeded") {
    return "committed";
  }
  if (
    run?.status === "rolled-back" ||
    (run?.origin.updateRecoveryCapture?.restored === true &&
      run.origin.updateRecoveryCapture.manifestSha256 === manifestSha256) ||
    run?.steps.some(
      (step) =>
        (step.step === "state rollback" || step.step === "previous generation restoration") &&
        step.status === "completed",
    )
  ) {
    return "restored";
  }
  return undefined;
}

/** Backup-local pending markers cannot override the update's durable terminal result. */
export async function inspectUpdateRecoveryBackups(params: { installRoot?: string } = {}) {
  const snapshots = await listBackups(params.installRoot);
  const { getUpdateRunAsync } = await import("./update-run-reader.js");
  return await Promise.all(
    snapshots.map(async ({ ref, manifest, outcome }) => {
      let terminalOutcome: "committed" | "restored" | undefined;
      let ambiguity: string | undefined;
      try {
        const run = await getUpdateRunAsync(manifest.runId);
        terminalOutcome = settledRunOutcome(run, ref.manifestSha256);
        if (outcome.status === "committed" || outcome.status === "restored") {
          if (terminalOutcome && terminalOutcome !== outcome.status) {
            terminalOutcome = undefined;
            ambiguity = "capture and update terminal outcomes disagree";
          } else {
            terminalOutcome = outcome.status;
          }
        }
        if (run?.origin.updateRecoveryCapture?.doctorCompleted && !terminalOutcome) {
          ambiguity = "Doctor succeeded but its older updater has no complete runtime validation";
        }
        if (!terminalOutcome && !ambiguity && run?.status !== "failed") {
          ambiguity = run ? `update run is ${run.status}` : "no matching update run exists";
        }
      } catch (error) {
        ambiguity = `update outcome is unreadable: ${formatErrorMessage(error)}`;
      }
      if (!terminalOutcome && !ambiguity && snapshots.length > 1) {
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
        status,
        terminalOutcome,
        nextAction,
        message: `Update recovery set ${ref.manifestPath}: ${reason}. ${status === "unresolved" ? "Keep the Gateway stopped and run" : "Automatic restoration is refused; inspect with"} \`${nextAction}\`.${status === "ambiguous" ? " Resolve the recorded outcome before retrying `npx openclaw@latest doctor --fix`." : ""}`,
      };
    }),
  );
}

export async function findPendingUpdateRecoveryBackup(
  params: { installRoot?: string; warn?: (message: string) => void } = {},
): Promise<UpdateRecoveryBackupRef | null> {
  const warn = params.warn ?? ((message: string) => log.warn(message));
  const inspections = await inspectUpdateRecoveryBackups(params);
  for (const inspection of inspections) {
    warn(inspection.message);
    if (inspection.terminalOutcome) {
      const { getUpdateRun } = await import("./update-run-ledger.js");
      try {
        await writeUpdateRecoveryBackupOutcome(
          inspection.ref,
          { status: inspection.terminalOutcome, error: inspection.message },
          {
            assertOwned: () => {
              if (
                settledRunOutcome(getUpdateRun(inspection.runId), inspection.ref.manifestSha256) !==
                inspection.terminalOutcome
              ) {
                throw new Error("Update terminal outcome changed during backup reconciliation.");
              }
            },
          },
        );
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
  return await withConfigMutationLock({ lockPath: resolveConfigPath() }, () =>
    retireUpdateRecoveryBackupOwned(ref, authority),
  );
}

async function retireUpdateRecoveryBackupOwned(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const { resumeUpdateRecoveryRetirement } = await import("./update-recovery-retirement.js");
  if (await resumeUpdateRecoveryRetirement(ref, authority)) {
    return;
  }
  await withRecoveryMetadata(ref, authority, async ({ outcome, pin, source, manifest }) => {
    if (!outcome) {
      throw new Error(`Update capture has no durable terminal outcome: ${ref.manifestPath}`);
    }
    const { UPDATE_CAPTURE_PRIVACY_MARKER } = await import("./update-capture-privacy-marker.js");
    const allowed = new Set([
      "manifest.json",
      "outcome.json",
      "payload",
      UPDATE_CAPTURE_PRIVACY_MARKER,
    ]);
    for (const entry of await source.list("", { withFileTypes: true })) {
      if (!allowed.has(entry.name)) {
        throw new Error(`Update capture contains unowned retirement input: ${entry.name}`);
      }
    }
    const captured = manifest.entries.filter((entry) => entry.kind === "file");
    const payload = await statOrMissing(path.join(ref.directory, "payload"));
    if (payload) {
      if (!payload.isDirectory()) {
        throw new Error("Update capture payload directory changed.");
      }
      const expected = new Set(captured.map((entry) => path.basename(entry.archivePath)));
      for (const entry of await source.list("payload", { withFileTypes: true })) {
        if (!expected.has(entry.name) || !entry.isFile) {
          throw new Error(`Update capture contains unowned retirement payload: ${entry.name}`);
        }
      }
      const identities = new Map<string, BigIntStats>();
      // Missing entries are already obsolete only because a write-once terminal outcome exists.
      for (const entry of captured) {
        if (!(await statOrMissing(path.join(ref.directory, entry.archivePath)))) {
          continue;
        }
        const opened = await source.open(entry.archivePath, {
          symlinks: "reject",
          hardlinks: "reject",
        });
        try {
          const before = await opened.handle.stat({ bigint: true });
          const actual = await sha256File(opened.handle);
          if (
            !sameFileMutationFingerprint(before, await opened.handle.stat({ bigint: true })) ||
            actual.bytes !== entry.size ||
            actual.digest !== entry.sha256
          ) {
            throw new Error(`Update retirement payload changed: ${entry.archivePath}`);
          }
          identities.set(entry.archivePath, before);
        } finally {
          await opened.handle.close();
        }
      }
      for (const entry of captured) {
        await pin.assertCurrent();
        authority.assertOwned();
        const identity = identities.get(entry.archivePath);
        if (identity) {
          const current = await fs.lstat(path.join(ref.directory, entry.archivePath), {
            bigint: true,
          });
          if (!sameFileMutationFingerprint(identity, current)) {
            throw new Error(
              `Update retirement payload changed before removal: ${entry.archivePath}`,
            );
          }
          authority.assertOwned();
          await source.remove(entry.archivePath);
        }
      }
      await pin.assertCurrent();
      authority.assertOwned();
      await source.remove("payload");
    }
    requireDirectorySync(await pin.sync(), "Update capture payload retirement");
    await pin.assertCurrent();
    authority.assertOwned();
    const { recordUpdateRunRecoveryCapture } = await import("./update-run-ledger.js");
    const identity = pin.receipt.identity;
    recordUpdateRunRecoveryCapture(
      manifest.runId,
      {
        manifestSha256: ref.manifestSha256,
        retirement: {
          directory: ref.directory,
          installRoot: manifest.installRoot,
          stateDir: manifest.stateDir,
          configPath: manifest.configPath,
          identity: { dev: identity.dev, ino: identity.ino, birthtimeMs: identity.birthtimeMs },
          outcome: outcome.status,
        },
      },
      authority.assertOwned,
    );
  });
  await resumeUpdateRecoveryRetirement(ref, authority);
}

export { inspectUpdateRecoveryRetirements } from "./update-recovery-retirement.js";

export {
  readUpdateRecoveryBackupManifest,
  readUpdateRecoveryBackupRef,
} from "./update-recovery-backup-metadata.js";
