import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigRecoveryArtifacts } from "../config/backup-rotation.js";
import { describeConfigJournalFingerprintKey } from "../config/config-journal-snapshot.js";
import { withConfigMutationLock } from "../config/mutate.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  assertPreparedAgentRecoveryRepresentation,
  prepareOpenClawStateRecoveryCopy,
  sanitizePreparedOpenClawStateCopy,
} from "../state/openclaw-state-recovery-preparation.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import type {
  UpdateRecoveryBackupRef,
  UpdateRecoveryConfigWrite,
} from "./update-recovery-backup-contract.js";
import {
  digest,
  fileDigest,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";

type Authority = { assertOwned: () => void; env: NodeJS.ProcessEnv };
type Entry = UpdateRecoveryBackupManifest["entries"][number];
type Verified = {
  manifest: UpdateRecoveryBackupManifest;
  payloads: Map<string, string>;
  assertCurrent: () => Promise<void>;
};

function equalEntry(left: Entry | undefined, right: Entry): boolean {
  if (!left) {
    return false;
  }
  if (left.kind === "file" && right.kind === "file") {
    const { archivePath: _left, ...a } = left;
    const { archivePath: _right, ...b } = right;
    return isDeepStrictEqual(a, b);
  }
  return isDeepStrictEqual(left, right);
}

function contentHash(entry: Entry | undefined): string | null | undefined {
  return entry?.kind === "file" ? entry.sha256 : entry?.kind === "missing" ? null : undefined;
}

function refuse(resource: string, reason: string): never {
  throw new Error(
    `Update recovery preparation refused for ${resource}: ${reason}. Baseline and candidate are retained; active state was not replaced.`,
  );
}

/** This only prepares private artifacts. It grants neither publication nor cleanup authority. */
async function sealUpdateRecoveryPreparedGeneration(params: {
  baselineRef: UpdateRecoveryBackupRef;
  candidateRef: UpdateRecoveryBackupRef;
  baseline: Verified;
  candidate: Verified;
  configWrites: readonly UpdateRecoveryConfigWrite[];
  assertOwned: () => void;
}): Promise<UpdateRecoveryBackupRef> {
  const { baseline, candidate } = params;
  const directory = path.join(params.baselineRef.directory, "prepared");
  if (await statOrMissing(directory)) {
    throw new Error(
      `Prepared recovery generation already exists at ${directory}; verify its sealed manifest instead of overwriting it. Incomplete artifacts remain retained for inspection.`,
    );
  }
  const assertCurrent = async () => {
    await baseline.assertCurrent();
    await candidate.assertCurrent();
    params.assertOwned();
  };
  await assertCurrent();
  const original = new Map(baseline.manifest.entries.map((entry) => [entry.sourcePath, entry]));
  const databaseOwners = new Map(candidate.manifest.databases?.map((entry) => [entry.path, entry]));
  const originalOwners = new Map(baseline.manifest.databases?.map((entry) => [entry.path, entry]));
  const config = new Set(candidate.manifest.configPaths);
  const configArtifacts = new Set(
    [...config].flatMap((pathname) => {
      const { backups, snapshot } = resolveConfigRecoveryArtifacts(pathname);
      return backups.concat(snapshot);
    }),
  );
  const writes = new Map(params.configWrites.map((write) => [write.path, write]));
  const fingerprintKey = describeConfigJournalFingerprintKey(candidate.manifest.stateDir);
  // Decide every non-database transformation before creating T. Directory
  // ownership never implies permission to prune new or changed plugin records.
  const selected = candidate.manifest.entries.map((entry) => {
    const before = original.get(entry.sourcePath);
    const owner = databaseOwners.get(entry.sourcePath);
    if (owner) {
      if (!isDeepStrictEqual(owner, originalOwners.get(entry.sourcePath))) {
        refuse(entry.sourcePath, "database owner is new or changed");
      }
      if (entry.kind === "missing" && before?.kind === "missing") {
        return { entry, source: candidate };
      }
      if (entry.kind !== "file" || !entry.sqlite || before?.kind !== "file" || !before.sqlite) {
        refuse(entry.sourcePath, "database creation/deletion has no selected-runtime admission");
      }
      return { entry, source: candidate, owner, before };
    }
    if (equalEntry(before, entry)) {
      return { entry, source: candidate };
    }
    // Rotation history is opaque user recovery data, not active configuration.
    // Preserve C\'s exact history (including already-rotated absences), never
    // restore B over newer backups or broaden this to arbitrary file suffixes.
    if (
      configArtifacts.has(entry.sourcePath) &&
      (!before || before.kind === "file" || before.kind === "missing") &&
      (entry.kind === "missing" || (entry.kind === "file" && !entry.sqlite))
    ) {
      return { entry, source: candidate };
    }
    // A first config write creates this fixed-format audit key. C\'s newer
    // journal rows depend on it; preserve it, never recreate or roll it back.
    // Replaced existing keys and all other unowned file changes still refuse.
    if (
      entry.sourcePath === fingerprintKey.path &&
      (!before || before.kind === "missing") &&
      entry.kind === "file" &&
      !entry.sqlite &&
      entry.size === fingerprintKey.byteLength &&
      (process.platform === "win32" || entry.mode === 0o600)
    ) {
      return { entry, source: candidate };
    }
    if (config.has(entry.sourcePath)) {
      const receipt = writes.get(entry.sourcePath);
      if (
        before &&
        receipt?.contiguous &&
        contentHash(before) !== undefined &&
        contentHash(entry) !== undefined &&
        receipt.beforeHash === contentHash(before) &&
        receipt.afterHash === contentHash(entry)
      ) {
        return { entry: before, source: baseline };
      }
      // Untracked bytes stay current. Exact selected-runtime validation must
      // admit them later; never serialize the merged config or substitute B.
      if (entry.kind === "file" && before?.kind === "file" && !entry.sqlite && !before.sqlite) {
        return { entry, source: candidate };
      }
    }
    return refuse(
      entry.sourcePath,
      "changed plugin/file/absence has no migration-owner reverse contract",
    );
  });
  for (const entry of baseline.manifest.entries) {
    if (!candidate.manifest.entries.some((current) => current.sourcePath === entry.sourcePath)) {
      refuse(entry.sourcePath, "candidate closure lost a baseline resource");
    }
  }
  await assertCurrent();
  await createPrivateSqliteDirectory(directory);
  const pin = await pinDirectory(directory);
  try {
    await fs.writeFile(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
      { flag: "wx", mode: 0o600 },
    );
    const payloadDirectory = path.join(directory, "payload");
    await createPrivateSqliteDirectory(payloadDirectory);
    const manifest: UpdateRecoveryBackupManifest = {
      ...candidate.manifest,
      generation: {
        kind: "prepared",
        baselineSha256: params.baselineRef.manifestSha256,
        candidateSha256: params.candidateRef.manifestSha256,
      },
      createdAt: new Date().toISOString(),
      entries: [],
    };
    for (const item of selected) {
      await assertCurrent();
      await pin.assertCurrent();
      if (item.entry.kind !== "file") {
        manifest.entries.push(item.entry);
        continue;
      }
      const archivePath = `payload/${manifest.entries.length}`;
      const targetPath = path.join(directory, archivePath);
      const source = item.source.payloads.get(item.entry.archivePath);
      if (!source) {
        refuse(item.entry.sourcePath, "verified source payload disappeared");
      }
      if (item.owner?.role === "global" && item.before?.kind === "file") {
        const baselinePath = baseline.payloads.get(item.before.archivePath);
        if (!baselinePath) {
          refuse(item.entry.sourcePath, "baseline database payload disappeared");
        }
        await prepareOpenClawStateRecoveryCopy({
          baselinePath,
          candidatePath: source,
          targetPath,
          assertOwned: params.assertOwned,
        });
        // The migration owner permits clearing process leases only in T.
        // B/C preserve them as evidence, never as renewed live authority.
        await sanitizePreparedOpenClawStateCopy(targetPath, {
          assertOwned: params.assertOwned,
        });
        await assertCurrent();
      } else {
        if (item.owner?.role === "agent") {
          const baselinePath = item.before && baseline.payloads.get(item.before.archivePath);
          if (!baselinePath) {
            refuse(item.entry.sourcePath, "baseline agent payload disappeared");
          }
          await assertPreparedAgentRecoveryRepresentation({
            baselinePath,
            candidatePath: source,
            agentId: item.owner.agentId,
            supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
            assertOwned: params.assertOwned,
          });
          await assertCurrent();
        }
        await fs.copyFile(source, targetPath, fs.constants.COPYFILE_EXCL);
      }
      const output = await fs.open(targetPath, "r+");
      try {
        await output.chmod(0o600);
        await output.sync();
      } finally {
        await output.close();
      }
      manifest.entries.push({ ...item.entry, archivePath, ...(await fileDigest(targetPath)) });
    }
    const raw = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) {
      refuse(directory, "prepared manifest exceeds the existing inventory bound");
    }
    parseUpdateRecoveryBackupManifest(raw);
    await assertCurrent();
    await pin.assertCurrent();
    const manifestPath = path.join(directory, "manifest.json");
    const output = await fs.open(manifestPath, "wx", 0o600);
    try {
      await output.writeFile(raw);
      await output.sync();
    } finally {
      await output.close();
    }
    requireDirectorySync(await syncDirectory(payloadDirectory), "Prepared recovery payloads");
    requireDirectorySync(await pin.sync(), "Prepared recovery generation");
    requireDirectorySync(
      await syncDirectory(params.baselineRef.directory),
      "Prepared recovery parent",
    );
    return { directory, manifestPath, manifestSha256: digest(raw) };
  } finally {
    await pin.close();
  }
}

/** Retain the owner-prepared T image. Exact runtime/publication admission is separate. */
export async function prepareUpdateRecoveryGeneration(
  ref: UpdateRecoveryBackupRef,
  candidateRef: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<UpdateRecoveryBackupRef> {
  return withConfigMutationLock({}, async () => {
    const baseline = await prepareVerifiedBackup(ref, { env: authority.env });
    let candidate: Awaited<ReturnType<typeof prepareVerifiedBackup>> | undefined;
    try {
      candidate = await prepareVerifiedBackup(candidateRef, { env: authority.env });
      if (
        baseline.manifest.generation?.kind !== "baseline" ||
        candidate.manifest.generation?.kind !== "candidate" ||
        candidate.manifest.generation.baselineSha256 !== ref.manifestSha256
      ) {
        throw new Error("Preparation requires this operation's verified baseline and candidate.");
      }
      authority.assertOwned();
      const directory = path.join(ref.directory, "prepared");
      let preparedRef: UpdateRecoveryBackupRef;
      if (await statOrMissing(directory)) {
        const source = await safeRoot(directory);
        const raw = (
          await source.read("manifest.json", {
            maxBytes: MAX_MANIFEST_BYTES,
            symlinks: "reject",
            hardlinks: "reject",
          })
        ).buffer;
        preparedRef = {
          directory,
          manifestPath: path.join(directory, "manifest.json"),
          manifestSha256: digest(raw),
        };
      } else {
        const { getUpdateRunAsync } = await import("./update-run-reader.js");
        const run = await getUpdateRunAsync(baseline.manifest.runId, { env: authority.env });
        authority.assertOwned();
        if (run?.origin.updateRecoveryCapture?.manifestSha256 !== ref.manifestSha256) {
          throw new Error("Prepared generation lost its admitted update/config receipt owner.");
        }
        preparedRef = await sealUpdateRecoveryPreparedGeneration({
          baselineRef: ref,
          candidateRef,
          baseline,
          candidate,
          configWrites: run.origin.updateRecoveryCapture.configWrites,
          assertOwned: authority.assertOwned,
        });
      }
      const verifiedPrepared = await prepareVerifiedBackup(preparedRef, { env: authority.env });
      const prepared = verifiedPrepared.manifest;
      await verifiedPrepared.close();
      if (
        prepared.generation?.kind !== "prepared" ||
        prepared.generation.candidateSha256 !== candidateRef.manifestSha256
      ) {
        throw new Error("Prepared generation belongs to another stopped candidate.");
      }
      await baseline.assertCurrent();
      await candidate.assertCurrent();
      authority.assertOwned();
      return preparedRef;
    } finally {
      try {
        await candidate?.close();
      } finally {
        await baseline.close();
      }
    }
  });
}
