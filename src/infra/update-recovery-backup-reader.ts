import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import {
  isNamedProfile,
  resolveCanonicalConfigPath,
  resolveConfigPath,
  resolveDefaultConfigCandidates,
  resolveStateDir,
} from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256Hex } from "./crypto-digest.js";
import { pinDirectory, sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { resolveLegacyStateDirMigrationCandidates } from "./state-migrations.state-dir.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "./update-capture-privacy-marker.js";
import {
  assertUpdateRecoverySealComplete,
  hasPendingUpdateRecoverySeal,
} from "./update-recovery-capture-seal.js";
import { recordedUpdateRunDrivers } from "./update-run-activity.js";
import { inspectUpdateRunDriver, sameUpdateRunDriver } from "./update-run-driver.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const updateRecoveryBackupRefSchema = z.strictObject({
  directory: z.string().min(1),
  manifestPath: z.string().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

const recordedOutcomeSchema = z.strictObject({
  status: z.enum(["restored", "committed"]),
  error: z.string().max(4096).optional(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

type Outcome = {
  status: "pending" | "restored" | "committed" | "restore-failed";
  error?: string;
};

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

function captureScopes(env: NodeJS.ProcessEnv): Map<string, Set<string>> {
  const selectedStateDir = resolvePathViaExistingAncestorSync(resolveStateDir(env));
  const selectedConfigPath = canonicalEntryPath(resolveConfigPath(env));
  const scopes = new Map([[selectedStateDir, new Set([selectedConfigPath])]]);
  if (isNamedProfile(env)) {
    return scopes;
  }
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const migrations = resolveLegacyStateDirMigrationCandidates({ env, homedir })
    .map(({ source, target }) => ({
      source: canonicalEntryPath(source),
      target: canonicalEntryPath(target),
    }))
    .filter(({ source, target }) => selectedStateDir === source || selectedStateDir === target);
  for (const { source, target } of migrations) {
    if (selectedStateDir !== target) {
      continue;
    }
    const relative = path.relative(target, selectedConfigPath);
    const movedConfig =
      !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
        ? path.join(source, relative)
        : selectedConfigPath;
    scopes.set(source, new Set([movedConfig]));
  }
  if (
    migrations.length > 0 &&
    !env.OPENCLAW_CONFIG_PATH?.trim() &&
    selectedConfigPath === canonicalEntryPath(resolveCanonicalConfigPath(env, selectedStateDir))
  ) {
    // Doctor may copy the legacy config to the canonical filename after relocating its directory.
    for (const candidate of resolveDefaultConfigCandidates(env, homedir)) {
      const stateDir = canonicalEntryPath(path.dirname(candidate));
      scopes.get(stateDir)?.add(path.join(stateDir, path.basename(candidate)));
    }
  }
  return scopes;
}

function assertManifestSelectedScope(
  manifest: UpdateRecoveryBackupManifest,
  scopes: Map<string, Set<string>>,
) {
  if (!scopes.get(manifest.stateDir)?.has(manifest.configPath)) {
    throw new Error("Update recovery backup belongs to another selected state or configuration.");
  }
}

function captureDirectory(runId: string, stateDir: string): string {
  // This is capture-time provenance: resolving today's legacy symlink would move its sibling.
  return path.join(resolveUpdateCaptureRoot(stateDir), runId);
}
const MAX_UPDATE_RECOVERY_OUTCOME_BYTES = 16 * 1024;
type RecordedOutcome = z.infer<typeof recordedOutcomeSchema>;

function assertManifestLocation(
  ref: UpdateRecoveryBackupRef,
  manifest: UpdateRecoveryBackupManifest,
) {
  if (
    ref.directory !==
    (manifest.generation && manifest.generation.kind !== "baseline"
      ? path.join(captureDirectory(manifest.runId, manifest.stateDir), manifest.generation.kind)
      : captureDirectory(manifest.runId, manifest.stateDir))
  ) {
    throw new Error("Update recovery backup belongs to another state directory or update run.");
  }
}

async function withRecoveryMetadata<T>(
  location: Omit<UpdateRecoveryBackupRef, "manifestSha256"> & { manifestSha256?: string },
  run: (state: {
    ref: UpdateRecoveryBackupRef;
    manifest: UpdateRecoveryBackupManifest;
    outcome?: RecordedOutcome;
    pin: Awaited<ReturnType<typeof pinDirectory>>;
  }) => Promise<T>,
  assertOwned?: () => void,
): Promise<T> {
  assertOwned?.();
  updateRecoveryBackupRefSchema.partial({ manifestSha256: true }).parse(location);
  if (
    path.resolve(location.directory) !== location.directory ||
    location.manifestPath !== path.join(location.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  const pin = await pinDirectory(location.directory);
  try {
    assertOwned?.();
    if (pin.receipt.realPath !== location.directory) {
      throw new Error("Update recovery capture changed location.");
    }
    await assertUpdateRecoverySealComplete(location.directory);
    const source = await safeRoot(location.directory, { symlinks: "reject", hardlinks: "reject" });
    assertOwned?.();
    const bytes = await source.readBytes("manifest.json", {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    assertOwned?.();
    const ref = { ...location, manifestSha256: sha256Hex(bytes) };
    if (location.manifestSha256 !== undefined && ref.manifestSha256 !== location.manifestSha256) {
      throw new Error("Update recovery manifest changed before metadata access.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(bytes.toString("utf8"));
    assertManifestLocation(ref, manifest);
    let outcome: RecordedOutcome | undefined;
    const outcomeEntry = await statOrMissing(path.join(ref.directory, "outcome.json"));
    assertOwned?.();
    if (outcomeEntry) {
      outcome = recordedOutcomeSchema.parse(
        await source.readJson("outcome.json", {
          maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
        }),
      );
      assertOwned?.();
      if (outcome.manifestSha256 !== ref.manifestSha256) {
        throw new Error("Update recovery outcome refers to another manifest.");
      }
    }
    await pin.assertCurrent();
    await assertUpdateRecoverySealComplete(location.directory);
    assertOwned?.();
    return await run({ ref, manifest, outcome, pin });
  } finally {
    await pin.close();
  }
}

/** Bind retained crash/refusal evidence without claiming it is a sealed or restorable generation. */
async function fingerprintIncompleteRecoveryGeneration(directory: string): Promise<string> {
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
  return sha256Hex(JSON.stringify(inventory));
}
/** This records repair of current state, never reverse publication or permission to delete B/C/T. */
async function readBinding(ref: UpdateRecoveryBackupRef) {
  return withRecoveryMetadata(ref, async ({ manifest, outcome, pin }) => {
    const run = await getUpdateRunAsync(manifest.runId);
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
      await assertUpdateRecoverySealComplete(directory);
      if (!(await statOrMissing(path.join(directory, "manifest.json")))) {
        // Preparation can stop before the final seal. Retain and bind all of
        // those bytes, but never label them a verified rollback generation.
        incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(directory);
        continue;
      }
      const source = await safeRoot(directory);
      const raw = await source.readBytes("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      });
      let generation;
      try {
        generation = parseUpdateRecoveryBackupManifest(raw.toString("utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        // The seal file itself is created before its write completes. A
        // truncated JSON prefix is evidence, not a published generation.
        incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(directory);
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
      generations[`${kind}Sha256`] = sha256Hex(raw);
    }
    await pin.assertCurrent();
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
export async function hasUpdateRecoveryForwardResolution(
  ref: UpdateRecoveryBackupRef,
): Promise<boolean> {
  return withRecoveryMetadata(ref, async ({ manifest, outcome }) => {
    const run = await getUpdateRunAsync(manifest.runId);
    const receipt = run?.origin.updateRecoveryCapture?.forwardResolution;
    if (!receipt) {
      return false;
    }
    if (outcome || !isDeepStrictEqual(receipt.binding, await readBinding(ref))) {
      throw new Error("Forward recovery receipt is stale or contradicts its failed capture.");
    }
    return true;
  });
}

/** Read original capture identity only; payload validity and restoration authority are separate. */
export async function readUpdateRecoveryBaselineIdentity(params: {
  runId: string;
  env: NodeJS.ProcessEnv;
  ref?: UpdateRecoveryBackupRef;
  installRoot?: string;
  readContinuation: () => UpdateRunRecord | undefined;
  assertCurrent: () => void;
}): Promise<{ ref: UpdateRecoveryBackupRef; manifest: UpdateRecoveryBackupManifest } | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId)) {
    throw new Error("Invalid original update capture run identity.");
  }
  const expectedRef = params.ref ? updateRecoveryBackupRefSchema.parse(params.ref) : undefined;
  if (expectedRef && !params.installRoot?.trim()) {
    throw new Error("An explicit original capture requires its admitted installation root.");
  }
  params.assertCurrent();
  const scopes = captureScopes(params.env);
  const candidates = expectedRef
    ? [expectedRef.directory]
    : [...scopes.keys()].map((stateDir) => captureDirectory(params.runId, stateDir));
  const present: string[] = [];
  for (const directory of candidates) {
    const entry = await statOrMissing(directory);
    params.assertCurrent();
    if (!entry) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error(`Original update capture is not a retained directory: ${directory}`);
    }
    present.push(directory);
  }
  const [directory] = present;
  if (directory === undefined) {
    if (expectedRef) {
      throw new Error("The admitted original update capture is unavailable.");
    }
    return undefined;
  }
  if (present.length !== 1) {
    throw new Error("Multiple original update captures belong to this run; preserve all evidence.");
  }
  let identity:
    | { ref: UpdateRecoveryBackupRef; manifest: UpdateRecoveryBackupManifest }
    | undefined;
  const assertReuseCurrent = () => {
    params.assertCurrent();
    const run = params.readContinuation();
    if (
      (!expectedRef && !run) ||
      (run && (run.runId !== params.runId || run.status !== "running" || run.finishedAtMs !== null))
    ) {
      throw new Error("Original capture reuse requires the same live update continuation.");
    }
    if (!identity) {
      return;
    }
    const { manifest, ref } = identity;
    assertManifestSelectedScope(manifest, scopes);
    const capture = run?.origin.updateRecoveryCapture;
    if (
      manifest.runId !== params.runId ||
      manifest.schemaVersion !== 2 ||
      manifest.generation?.kind !== "baseline" ||
      (params.installRoot !== undefined &&
        manifest.installRoot !== path.resolve(params.installRoot)) ||
      (capture &&
        (capture.manifestSha256 !== ref.manifestSha256 ||
          capture.status !== "pending" ||
          capture.restored ||
          capture.retirement ||
          capture.forwardResolution))
    ) {
      throw new Error("Original update capture identity or pending state changed.");
    }
    if (!expectedRef && run) {
      const recorded = recordedUpdateRunDrivers(run);
      if (
        inspectUpdateRunDriver(manifest.creator) !== "dead" ||
        manifest.drivers.some(
          (driver) => !recorded.some((current) => sameUpdateRunDriver(driver, current)),
        ) ||
        !manifest.drivers.some((driver) => inspectUpdateRunDriver(driver) === "alive")
      ) {
        throw new Error("Original update capture does not share its admitted live driver lineage.");
      }
    }
  };
  const result = await withRecoveryMetadata(
    expectedRef ?? { directory, manifestPath: path.join(directory, "manifest.json") },
    async ({ ref, manifest, outcome, pin }) => {
      identity = { ref, manifest };
      assertReuseCurrent();
      if (outcome) {
        throw new Error("A terminal update capture cannot be reused as the original baseline.");
      }
      for (const kind of ["candidate", "prepared"] as const) {
        const entry = await statOrMissing(path.join(directory, kind));
        assertReuseCurrent();
        if (entry) {
          throw new Error("Original update capture already has later recovery generations.");
        }
      }
      await pin.assertCurrent();
      assertReuseCurrent();
      return identity;
    },
    assertReuseCurrent,
  );
  assertReuseCurrent();
  return result;
}

type UpdateRecoveryBackupRead =
  | {
      kind: "sealed";
      ref: UpdateRecoveryBackupRef;
      manifest: UpdateRecoveryBackupManifest;
      outcome: Outcome;
    }
  | { kind: "incomplete"; directory: string };

export async function readUpdateRecoveryBackups(): Promise<UpdateRecoveryBackupRead[]> {
  const result: UpdateRecoveryBackupRead[] = [];
  const scopes = captureScopes(process.env);
  for (const stateDir of scopes.keys()) {
    const store = resolveUpdateCaptureRoot(stateDir);
    if (!(await statOrMissing(store))) {
      continue;
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
      if (
        entry?.isDirectory() &&
        /^openclaw-update-canary-.+$/u.test(captureId) &&
        !manifestEntry
      ) {
        continue;
      }
      if (
        entry?.isDirectory() &&
        /^[a-zA-Z0-9_-]{1,128}$/u.test(captureId) &&
        (!manifestEntry || (await hasPendingUpdateRecoverySeal(directory)))
      ) {
        result.push({ kind: "incomplete", directory });
        continue;
      }
      if (!entry?.isDirectory() || !manifestEntry?.isFile()) {
        throw new Error(
          `Unresolved update capture ${directory} has incomplete publication. Inspection only: openclaw update status --json; npx openclaw@latest doctor --fix. Earlier captures are retained.`,
        );
      }
      const source = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
      const raw = await source.readText("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
      });
      const manifest = parseUpdateRecoveryBackupManifest(raw);
      const ref = { directory, manifestPath, manifestSha256: sha256Hex(raw) };
      assertManifestLocation(ref, manifest);
      assertManifestSelectedScope(manifest, scopes);
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
          await source.readJson("outcome.json", {
            maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
          }),
        );
        if (terminal.manifestSha256 !== ref.manifestSha256) {
          throw new Error(`Update recovery outcome refers to another manifest: ${manifestPath}`);
        }
        outcome = terminal;
      } else {
        outcome = { status: capture?.status ?? "pending", error: capture?.error };
      }
      result.push({ kind: "sealed", ref, manifest, outcome });
    }
  }
  return result.toSorted((a, b) => {
    if (a.kind === "incomplete") {
      return b.kind === "incomplete" ? a.directory.localeCompare(b.directory) : 1;
    }
    return b.kind === "incomplete" ? -1 : b.manifest.createdAt.localeCompare(a.manifest.createdAt);
  });
}
