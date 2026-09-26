import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { pinDirectory, requireDirectorySync } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import { digest } from "./update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";
import {
  assertUpdateRecoverySourceInventory,
  captureUpdateRecoverySourceInventory,
  type UpdateRecoverySourceResource,
  type UpdateRecoverySourceInventory,
} from "./update-recovery-source-image.js";
import {
  MAX_SOURCE_ATTESTATION_BYTES,
  serializeUpdateRecoverySourceAttestation,
  type UpdateRecoverySourceAttestation,
  type UpdateRecoverySourceRef,
} from "./update-recovery-source-schema.js";
import { captureUpdateRecoverySourceSnapshot } from "./update-recovery-source-snapshot.js";

export type UpdateRecoverySourceAttestationRef = Readonly<UpdateRecoverySourceRef>;
const capturedSources = new WeakMap<
  UpdateRecoverySourceAttestationRef,
  {
    inventory: UpdateRecoverySourceInventory;
    assertUnchanged: () => Promise<void>;
    assertCapturedSource: (
      ref: Readonly<UpdateRecoverySourceRef>,
      source: Readonly<UpdateRecoverySourceAttestation>,
    ) => void;
  }
>();

/** Only a ref produced in this same capture lifetime can supply physical images.
 * Serialized attestations belong to the lower's strict durable protocol reader. */
export function capturedUpdateRecoverySource(ref: UpdateRecoverySourceAttestationRef) {
  const captured = capturedSources.get(ref);
  if (!captured) {
    throw new Error("Source ref is not this live capture's attestation.");
  }
  return captured;
}

export type UpdateRecoverySourcePublication = {
  operationId: string;
  /** Continuing original executor AND stopped-C native publication maintenance. */
  assertCurrent: () => void;
  onSealed: (ref: UpdateRecoverySourceAttestationRef) => void;
};

// Only wrappers composed here can be reused as an already-combined guard.
// Equal external methods may have different receivers and must both run.
const combinedSourceAssertions = new WeakSet<() => void>();
export function bindUpdateRecoverySourceAssertions(
  authority: { assertOwned: () => void },
  publication: { assertCurrent: () => void },
): () => void {
  if (
    authority.assertOwned === publication.assertCurrent &&
    combinedSourceAssertions.has(authority.assertOwned)
  ) {
    return authority.assertOwned;
  }
  const assertOwned = authority.assertOwned.bind(authority);
  const assertPublication = publication.assertCurrent.bind(publication);
  const assertCurrent = () => {
    assertOwned();
    assertPublication();
  };
  combinedSourceAssertions.add(assertCurrent);
  return assertCurrent;
}

/** Detach the assertions and identity before discovery can yield. */
export function bindUpdateRecoverySourcePublication<
  T extends {
    assertOwned: () => void;
    baseline?: unknown;
    sourcePublication?: UpdateRecoverySourcePublication;
  },
>(input: T): T {
  const publication = input.sourcePublication;
  if (!publication) {
    return input;
  }
  if (!input.baseline) {
    throw new Error("Source publication requires a stopped candidate, not baseline capture.");
  }
  const assertCurrent = bindUpdateRecoverySourceAssertions(input, publication);
  return {
    ...input,
    assertOwned: assertCurrent,
    sourcePublication: {
      operationId: publication.operationId,
      assertCurrent,
      onSealed: publication.onSealed.bind(publication),
    },
  };
}

export function updateRecoveryInspectedSourceResources(input: {
  manifest: Pick<UpdateRecoveryBackupManifest, "entries">;
  files: { pathname: string; sqlite: boolean }[];
}): UpdateRecoverySourceResource[] {
  return [
    ...updateRecoveryManifestSourceResources(input.manifest),
    ...input.files.map((file) => ({
      sourcePath: file.pathname,
      kind: "file" as const,
      ...(file.sqlite ? { sqlite: true } : {}),
    })),
  ];
}

export async function captureInspectedUpdateRecoverySourcePublication(
  params: {
    runId: string;
    env: NodeJS.ProcessEnv;
    assertOwned: () => void;
    sourcePublication?: UpdateRecoverySourcePublication;
  },
  inspected: Parameters<typeof updateRecoveryInspectedSourceResources>[0],
) {
  return params.sourcePublication
    ? await captureUpdateRecoverySourcePublication({
        runId: params.runId,
        env: params.env,
        operationId: params.sourcePublication.operationId,
        resources: updateRecoveryInspectedSourceResources(inspected),
        assertCurrent: params.assertOwned,
      })
    : undefined;
}

function updateRecoveryManifestSourceResources(
  manifest: Pick<UpdateRecoveryBackupManifest, "entries">,
): UpdateRecoverySourceResource[] {
  return manifest.entries.map((entry) => ({
    sourcePath: entry.sourcePath,
    kind: entry.kind,
    ...((entry.kind === "file" || entry.kind === "missing") && entry.sqlite
      ? { sqlite: true }
      : {}),
  }));
}

/** Capture proof is closure-owned. There is no API accepting caller-authored
 * inventory, a saved JSON attestation, or a newly observed replacement image. */
async function captureUpdateRecoverySourcePublication(params: {
  runId: string;
  env: NodeJS.ProcessEnv;
  operationId: string;
  resources: readonly UpdateRecoverySourceResource[];
  assertCurrent: () => void;
}) {
  const { runId, operationId, assertCurrent, env } = params;
  const inventory = await captureUpdateRecoverySourceInventory(params);
  let sealing = false;
  const snapshots = new Map<string, { targetPath: string; assertCurrent: () => void }>();
  const attemptedSnapshots = new Set<string>();
  const assertUnchanged = async (resources: readonly UpdateRecoverySourceResource[]) => {
    await assertUpdateRecoverySourceInventory(inventory, {
      runId,
      operationId,
      resources,
      assertCurrent,
    });
  };
  return {
    assertUnchanged,
    async snapshot(
      input: Omit<Parameters<typeof captureUpdateRecoverySourceSnapshot>[0], "assertCurrent">,
    ) {
      const snapshot = { ...input };
      assertCurrent();
      const resource = inventory.resources.find((r) => r.sourcePath === snapshot.sourcePath);
      if (
        sealing ||
        attemptedSnapshots.has(snapshot.sourcePath) ||
        resource?.image.kind !== "file" ||
        !resource.sidecars.length
      ) {
        throw new Error("SQLite snapshot is not an uncaptured original source resource.");
      }
      attemptedSnapshots.add(snapshot.sourcePath);
      const assertSnapshot = await captureUpdateRecoverySourceSnapshot({
        ...snapshot,
        assertCurrent,
      });
      snapshots.set(snapshot.sourcePath, {
        targetPath: snapshot.targetPath,
        assertCurrent: assertSnapshot,
      });
    },
    async seal(input: UpdateRecoveryBackupRef): Promise<UpdateRecoverySourceAttestationRef> {
      const candidate = Object.freeze(structuredClone(input));
      assertCurrent();
      if (sealing) {
        throw new Error("Stopped candidate source attestation is write-once.");
      }
      sealing = true;
      // Strict manifest AND payload verification, including SQLite integrity,
      // precedes attestation. The manifest digest keeps its payload semantics.
      const verified = await prepareVerifiedBackup(candidate, { env });
      try {
        const manifest = verified.manifest;
        if (manifest.runId !== runId || manifest.generation?.kind !== "candidate") {
          throw new Error("Source attestation requires this run's stopped candidate.");
        }
        const resources = updateRecoveryManifestSourceResources(manifest);
        const expected = inventory.resources.map((resource) => ({
          sourcePath: resource.sourcePath,
          kind: resource.image.kind,
          ...(resource.sidecars.length ? { sqlite: true } : {}),
        }));
        if (
          !isDeepStrictEqual(
            resources.toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
            expected,
          )
        ) {
          throw new Error("Candidate source attestation inventory is not one-to-one.");
        }
        const images = new Map(inventory.resources.map((r) => [r.sourcePath, r.image]));
        for (const entry of manifest.entries) {
          const image = images.get(entry.sourcePath)!;
          if (
            ((entry.kind === "file" || entry.kind === "directory") &&
              (image.kind !== entry.kind || image.mode !== entry.mode)) ||
            (entry.kind === "symlink" &&
              (image.kind !== "symlink" || image.target !== entry.target))
          ) {
            throw new Error("Candidate source metadata does not match its manifest.");
          }
          if (
            entry.kind === "file" &&
            image.kind === "file" &&
            !entry.sqlite &&
            (entry.sha256 !== image.sha256 || entry.size !== image.size)
          ) {
            throw new Error("Candidate ordinary-file payload differs from captured source.");
          }
        }
        const assertSnapshots = () => {
          const entries = manifest.entries.filter((entry) => entry.kind === "file" && entry.sqlite);
          if (snapshots.size !== entries.length || attemptedSnapshots.size !== snapshots.size) {
            throw new Error(
              "Candidate SQLite payload lacks its original native snapshot operation.",
            );
          }
          for (const entry of entries) {
            if (entry.kind !== "file") {
              throw new Error("Invalid SQLite snapshot entry.");
            }
            const snapshot = snapshots.get(entry.sourcePath);
            if (
              !snapshot ||
              snapshot.targetPath !== path.join(candidate.directory, entry.archivePath)
            ) {
              throw new Error("Candidate SQLite payload names another snapshot operation.");
            }
            snapshot.assertCurrent();
          }
        };
        assertSnapshots();
        const attestation: UpdateRecoverySourceAttestation = Object.freeze({
          protocol: "update-recovery-source-v1",
          runId,
          operationId,
          candidateManifestSha256: candidate.manifestSha256,
          resources: inventory.resources,
        });
        const raw = Buffer.from(serializeUpdateRecoverySourceAttestation(attestation));
        const pin = await pinDirectory(candidate.directory);
        try {
          await verified.assertCurrent();
          await assertUnchanged(resources);
          await pin.assertCurrent();
          assertCurrent();
          const target = path.join(candidate.directory, "source-attestation.json");
          // Exclusive creation deliberately leaves incomplete evidence on error.
          // A retry never reconstructs proof from a newer live generation.
          const output = await fs.open(target, "wx", 0o600);
          try {
            await output.writeFile(raw);
            await output.chmod(0o600);
            await output.sync();
          } finally {
            await output.close();
          }
          requireDirectorySync(await pin.sync(), "Candidate source attestation");
          await assertUnchanged(resources);
          await verified.assertCurrent();
          const saved = await (
            await safeRoot(candidate.directory)
          ).read("source-attestation.json", {
            maxBytes: MAX_SOURCE_ATTESTATION_BYTES,
            symlinks: "reject",
            hardlinks: "reject",
          });
          if (!saved.buffer.equals(raw)) {
            throw new Error("Candidate source attestation changed during publication.");
          }
          await pin.assertCurrent();
          assertCurrent();
          assertSnapshots();
          const ref = Object.freeze({ path: target, sha256: digest(raw) });
          capturedSources.set(
            ref,
            Object.freeze({
              inventory,
              assertUnchanged: () => assertUnchanged(resources),
              assertCapturedSource(
                receivedRef: Readonly<UpdateRecoverySourceRef>,
                receivedSource: Readonly<UpdateRecoverySourceAttestation>,
              ) {
                assertCurrent();
                if (
                  !isDeepStrictEqual(receivedRef, ref) ||
                  !isDeepStrictEqual(receivedSource, attestation)
                ) {
                  throw new Error("Source admission does not match this original sealed capture.");
                }
              },
            }),
          );
          return ref;
        } finally {
          await pin.close();
        }
      } finally {
        await verified.close();
      }
    },
  };
}
