import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "./update-capture-privacy-marker.js";
import { updateRecoveryCaptureStateSchema } from "./update-recovery-receipt-schema.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type Authority = { assertOwned: () => void };
const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const updateRecoveryTerminalOutcomeSchema = z
  .object({
    status: z.enum(["restored", "committed"]),
    error: z.string().max(4096).optional(),
    manifestSha256: sha256,
  })
  .strict();

const updateRecoveryForwardResolutionSchema =
  updateRecoveryCaptureStateSchema.shape.forwardResolution.unwrap();
const outcomeSchema = z
  .object({
    status: z.enum(["pending", "restored", "committed", "restore-failed"]),
    error: z.string().optional(),
  })
  .strict();
type Outcome = z.infer<typeof outcomeSchema>;
const recordedOutcomeSchema = updateRecoveryTerminalOutcomeSchema;

async function statOrMissing(pathname: string) {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function fileDigest(pathname: string): Promise<{ size: number; sha256: string }> {
  const source = await (
    await safeRoot(path.dirname(pathname))
  ).open(path.basename(pathname), { symlinks: "reject", hardlinks: "reject" });
  try {
    const before = await source.handle.stat({ bigint: true });
    const hashed = await sha256File(source.handle);
    if (!sameFileMutationFingerprint(before, await source.handle.stat({ bigint: true }))) {
      throw new Error(`Update recovery payload changed while reading: ${pathname}`);
    }
    return { size: hashed.bytes, sha256: hashed.digest };
  } finally {
    await source.handle.close();
  }
}

function canonicalEntryPath(pathname: string): string {
  const absolute = path.resolve(pathname);
  return path.join(
    resolvePathViaExistingAncestorSync(path.dirname(absolute)),
    path.basename(absolute),
  );
}

const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function backupStore(stateDir = resolveStateDir()): string {
  return `${resolvePathViaExistingAncestorSync(stateDir)}.update-captures`;
}

function captureDirectory(runId: string, stateDir?: string): string {
  return path.join(backupStore(stateDir), runId);
}
const MAX_UPDATE_RECOVERY_OUTCOME_BYTES = 16 * 1024;
type RecordedOutcome = z.infer<typeof recordedOutcomeSchema>;

function assertManifestLocation(
  ref: UpdateRecoveryBackupRef,
  manifest: UpdateRecoveryBackupManifest,
) {
  if (
    manifest.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir()) ||
    manifest.configPath !== canonicalEntryPath(resolveConfigPath()) ||
    ref.directory !==
      (manifest.generation && manifest.generation.kind !== "baseline"
        ? path.join(captureDirectory(manifest.runId, manifest.stateDir), manifest.generation.kind)
        : captureDirectory(manifest.runId, manifest.stateDir))
  ) {
    throw new Error("Update recovery backup belongs to another state directory or update run.");
  }
}

async function withRecoveryMetadata<T>(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  run: (state: {
    manifest: UpdateRecoveryBackupManifest;
    outcome?: RecordedOutcome;
    source: Awaited<ReturnType<typeof safeRoot>>;
    pin: Awaited<ReturnType<typeof pinDirectory>>;
  }) => Promise<T>,
): Promise<T> {
  authority.assertOwned();
  updateRecoveryBackupRefSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  const pin = await pinDirectory(ref.directory);
  try {
    const source = await safeRoot(ref.directory);
    const bytes = await source.read("manifest.json", {
      maxBytes: MAX_MANIFEST_BYTES,
      symlinks: "reject",
      hardlinks: "reject",
    });
    if (digest(bytes.buffer) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest changed before metadata access.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(bytes.buffer.toString("utf8"));
    assertManifestLocation(ref, manifest);
    let outcome: RecordedOutcome | undefined;
    if (await statOrMissing(path.join(ref.directory, "outcome.json"))) {
      outcome = recordedOutcomeSchema.parse(
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
      if (outcome.manifestSha256 !== ref.manifestSha256) {
        throw new Error("Update recovery outcome refers to another manifest.");
      }
    }
    await pin.assertCurrent();
    authority.assertOwned();
    return await run({ manifest, outcome, source, pin });
  } finally {
    await pin.close();
  }
}

/** Bind retained crash/refusal evidence without claiming it is a sealed or restorable generation. */
async function fingerprintIncompleteRecoveryGeneration(
  directory: string,
  assertOwned: () => void,
): Promise<string> {
  const observed = new Map<string, BigIntStats>();
  const inventory: unknown[] = [];
  const walk = async (current: string): Promise<void> => {
    const pin = await pinDirectory(current);
    try {
      if (pin.receipt.realPath !== current) {
        throw new Error("Incomplete recovery generation changed location.");
      }
      const before = await fs.lstat(current, { bigint: true });
      observed.set(current, before);
      const source = await safeRoot(current);
      const entries = (await source.list("", { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        assertOwned();
        const pathname = path.join(current, entry.name);
        if (entry.isDirectory) {
          await walk(pathname);
        } else if (entry.isFile) {
          const identity = await fs.lstat(pathname, { bigint: true });
          observed.set(pathname, identity);
          inventory.push([path.relative(directory, pathname), await fileDigest(pathname)]);
        } else {
          throw new Error("Incomplete recovery generation contains an unsupported file kind.");
        }
      }
      await pin.assertCurrent();
      assertOwned();
    } finally {
      await pin.close();
    }
  };
  await walk(directory);
  for (const [pathname, before] of observed) {
    const after = await fs.lstat(pathname, { bigint: true });
    if (!sameFileMutationFingerprint(before, after) || before.mode !== after.mode) {
      throw new Error("Incomplete recovery generation changed while binding its evidence.");
    }
    inventory.push([
      path.relative(directory, pathname),
      [
        before.dev,
        before.ino,
        before.mode,
        before.size,
        before.birthtimeNs,
        before.mtimeNs,
        before.ctimeNs,
      ].map(String),
    ]);
  }
  assertOwned();
  return digest(JSON.stringify(inventory));
}
/** This records repair of current state, never reverse publication or permission to delete B/C/T. */
async function readBinding(ref: UpdateRecoveryBackupRef, authority: Authority) {
  return withRecoveryMetadata(ref, authority, async ({ manifest, outcome, pin }) => {
    const run = await getUpdateRunAsync(manifest.runId);
    authority.assertOwned();
    const capture = run?.origin.updateRecoveryCapture;
    if (
      outcome ||
      run?.status !== "failed" ||
      run.finishedAtMs === null ||
      !capture ||
      capture.manifestSha256 !== ref.manifestSha256 ||
      capture.restored ||
      capture.retirement ||
      manifest.schemaVersion !== 2 ||
      manifest.generation?.kind !== "baseline"
    ) {
      throw new Error("Forward recovery requires the same failed run and unresolved baseline.");
    }
    const generations: { candidateSha256: string | null; preparedSha256: string | null } = {
      candidateSha256: null,
      preparedSha256: null,
    };
    const incompleteGenerations: Partial<Record<"candidate" | "prepared", string>> = {};
    for (const kind of ["candidate", "prepared"] as const) {
      const directory = path.join(ref.directory, kind);
      if (!(await statOrMissing(directory))) {
        continue;
      }
      if (!(await statOrMissing(path.join(directory, "manifest.json")))) {
        // Preparation can stop before the final seal. Retain and bind all of
        // those bytes, but never label them a verified rollback generation.
        incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(
          directory,
          authority.assertOwned,
        );
        continue;
      }
      const source = await safeRoot(directory);
      const raw = (
        await source.read("manifest.json", {
          maxBytes: MAX_MANIFEST_BYTES,
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer;
      let generation;
      try {
        generation = parseUpdateRecoveryBackupManifest(raw.toString("utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        // The seal file itself is created before its write completes. A
        // truncated JSON prefix is evidence, not a published generation.
        incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(
          directory,
          authority.assertOwned,
        );
        continue;
      }
      if (
        generation.runId !== manifest.runId ||
        generation.installRoot !== manifest.installRoot ||
        generation.stateDir !== manifest.stateDir ||
        generation.configPath !== manifest.configPath ||
        generation.generation?.kind !== kind ||
        generation.generation.baselineSha256 !== ref.manifestSha256 ||
        (generation.generation.kind === "prepared" &&
          generation.generation.candidateSha256 !== generations.candidateSha256)
      ) {
        throw new Error("Forward recovery generation identity changed.");
      }
      if (kind === "candidate") {
        generations.candidateSha256 = digest(raw);
      } else {
        generations.preparedSha256 = digest(raw);
      }
    }
    await pin.assertCurrent();
    authority.assertOwned();
    return {
      runId: manifest.runId,
      failedAtMs: run.finishedAtMs,
      manifestSha256: ref.manifestSha256,
      installRoot: manifest.installRoot,
      stateDir: manifest.stateDir,
      configPath: manifest.configPath,
      ...generations,
      ...(Object.keys(incompleteGenerations).length > 0 ? { incompleteGenerations } : {}),
    };
  });
}

/** Missing receipt keeps admission closed. Malformed or contradictory receipts fail closed. */
async function hasUpdateRecoveryForwardResolution(
  ref: UpdateRecoveryBackupRef,
  authority: Authority = { assertOwned() {} },
): Promise<boolean> {
  return withRecoveryMetadata(ref, authority, async ({ manifest, outcome }) => {
    const run = await getUpdateRunAsync(manifest.runId);
    authority.assertOwned();
    const value = run?.origin.updateRecoveryCapture?.forwardResolution;
    if (!value) {
      return false;
    }
    const receipt = updateRecoveryForwardResolutionSchema.parse(value);
    if (outcome || !isDeepStrictEqual(receipt.binding, await readBinding(ref, authority))) {
      throw new Error("Forward recovery receipt is stale or contradicts its failed capture.");
    }
    authority.assertOwned();
    return true;
  });
}

function resolveUpdateRecoveryTerminalOutcome(
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
  for (const captureId of await fs.readdir(store)) {
    if (captureId === UPDATE_CAPTURE_PRIVACY_MARKER) {
      continue;
    }
    const directory = path.join(store, captureId);
    const entry = await statOrMissing(directory);
    // Doctor's schema archives share this root but are not recovery captures.
    if (entry?.isFile() && /^agent-schema-.+\.tar\.gz$/u.test(captureId)) {
      continue;
    }
    const manifestPath = path.join(directory, "manifest.json");
    const manifestEntry = entry?.isDirectory() ? await statOrMissing(manifestPath) : undefined;
    // Rehearsal scratch uses this prefix on every platform. A present manifest
    // still belongs to recovery validation, even under a scratch-like name.
    if (entry?.isDirectory() && /^openclaw-update-canary-.+$/u.test(captureId) && !manifestEntry) {
      continue;
    }
    if (!entry?.isDirectory() || !manifestEntry?.isFile()) {
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
    const capture = (await getUpdateRunAsync(manifest.runId))?.origin.updateRecoveryCapture;
    if (capture && capture.manifestSha256 !== ref.manifestSha256) {
      throw new Error(
        `Update capture identity changed: ${manifestPath}. Inspect with openclaw update status --json; npx openclaw@latest doctor --fix.`,
      );
    }
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
      outcome = { status: capture?.status ?? "pending", error: capture?.error };
    }
    result.push({ ref, manifest, outcome });
  }
  return result.toSorted((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

/** Backup-local pending markers cannot override the update's durable terminal result. */
export async function inspectUpdateRecoveryBackups(
  params: { installRoot?: string; forwardRepair?: true } = {},
) {
  const snapshots = await listBackups(params.installRoot);
  const forwardResolved = new Set<string>();
  for (const { ref } of snapshots) {
    if (await hasUpdateRecoveryForwardResolution(ref)) {
      forwardResolved.add(ref.manifestSha256);
    }
  }
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
