import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import type { PackageActivationDescriptor } from "./package-update-activation-journal.js";
import type { PackageActivationReversePreparation } from "./package-update-activation-reverse-schema.js";
import type { UpdateInitialStoreSelection } from "./update-initial-store-admission.js";
import { captureUpdateRecoverySourceInventory } from "./update-recovery-source-image.js";
import { serializeUpdateRecoverySourceAttestation } from "./update-recovery-source-schema.js";

const identity = (file: string) => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

export async function createUnchangedReversePreparation(params: {
  root: string;
  runId: string;
  state: string;
  packageRoot: string;
  operationId: string;
  descriptor: PackageActivationDescriptor;
  selection: UpdateInitialStoreSelection;
  packageResources: PackageActivationReversePreparation["packageResources"];
  stagingParent: string;
  preparedValue?: string;
}) {
  const capture = path.join(params.root, "reverse-generations");
  const configPath = path.join(path.dirname(params.state), "openclaw.json");
  const references: Array<{ directory: string; manifestPath: string; manifestSha256: string }> = [];
  for (const kind of ["baseline", "candidate", "prepared"] as const) {
    const directory = path.join(capture, kind);
    fs.mkdirSync(path.join(directory, "payload"), { recursive: true, mode: 0o700 });
    const payloadPath = path.join(directory, "payload/2");
    fs.copyFileSync(params.state, payloadPath);
    if (kind === "prepared" && params.preparedValue) {
      const prepared = new DatabaseSync(payloadPath);
      try {
        prepared.prepare("INSERT INTO acknowledged VALUES (?)").run(params.preparedValue);
      } finally {
        prepared.close();
      }
    }
    const stat = fs.statSync(payloadPath);
    const payload = fs.readFileSync(payloadPath);
    const manifest = {
      schemaVersion: 2,
      kind: "update-recovery",
      generation:
        kind === "baseline"
          ? { kind }
          : kind === "candidate"
            ? { kind, baselineSha256: references[0]!.manifestSha256 }
            : {
                kind,
                baselineSha256: references[0]!.manifestSha256,
                candidateSha256: references[1]!.manifestSha256,
              },
      databases: [{ path: params.state, role: "global" }],
      runId: params.runId,
      installRoot: params.packageRoot,
      stateDir: path.dirname(params.state),
      configPath,
      configPaths: [configPath],
      creator: { host: "reverse-helper-test", pid: process.pid, startIdentity: "1" },
      drivers: [],
      createdAt: new Date().toISOString(),
      roots: [path.dirname(params.state)],
      excludedRoots: [],
      protectedPaths: [`${configPath}.lock`],
      entries: [
        { kind: "directory", sourcePath: path.dirname(params.state), mode: 0o700 },
        { kind: "missing", sourcePath: configPath, sqlite: false, directory: false },
        {
          kind: "file",
          sourcePath: params.state,
          archivePath: "payload/2",
          sqlite: true,
          mode: stat.mode & 0o7777,
          sha256: createHash("sha256").update(payload).digest("hex"),
          size: payload.length,
        },
      ],
    };
    const raw = `${JSON.stringify(manifest)}\n`;
    const manifestPath = path.join(directory, "manifest.json");
    fs.writeFileSync(manifestPath, raw, { mode: 0o600 });
    references.push({
      directory,
      manifestPath,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    });
  }
  const configLock = `${configPath}.lock`;
  fs.writeFileSync(configLock, "captured config lock\n", { mode: 0o600 });
  const inventory = await captureUpdateRecoverySourceInventory({
    runId: params.runId,
    operationId: params.operationId,
    resources: [
      { sourcePath: path.dirname(params.state), kind: "directory" },
      { sourcePath: configPath, kind: "missing" },
      { sourcePath: params.state, kind: "file", sqlite: true },
    ],
    assertCurrent: () => {},
  });
  const sourcePath = path.join(capture, "source.json");
  const sourceRaw = serializeUpdateRecoverySourceAttestation({
    protocol: "update-recovery-source-v1",
    runId: params.runId,
    operationId: params.operationId,
    candidateManifestSha256: references[1]!.manifestSha256,
    resources: inventory.resources,
  });
  fs.writeFileSync(sourcePath, sourceRaw, { mode: 0o600 });
  const preparedManifest = parseUpdateRecoveryBackupManifest(
    fs.readFileSync(references[2]!.manifestPath, "utf8"),
  );
  const target = params.descriptor.previousRuntime;
  if (
    !target?.buildInfoSha256 ||
    !target.buildId ||
    !target.sourceCommit ||
    !target.entrypoint ||
    !target.entrypointSha256
  ) {
    throw new Error("Reverse helper fixture lacks a selected original runtime");
  }
  return {
    protocol: "package-state-reverse-preparation-v1",
    operationId: params.operationId,
    runId: params.runId,
    baseline: references[0]!,
    candidate: references[1]!,
    prepared: references[2]!,
    sourceAttestation: {
      path: sourcePath,
      sha256: createHash("sha256").update(sourceRaw).digest("hex"),
    },
    target: {
      ...target,
      buildInfoSha256: target.buildInfoSha256,
      buildId: target.buildId,
      sourceCommit: target.sourceCommit,
      entrypoint: target.entrypoint,
      entrypointSha256: target.entrypointSha256,
      admissionSha256: createHash("sha256")
        .update(
          JSON.stringify([
            {
              schema: "openclaw.state-schema-preflight.v1",
              status: "exact",
              foundVersion: 19,
              targetVersion: 19,
              requiresWrite: false,
              issues: [],
            },
          ]),
        )
        .digest("hex"),
      startupProtocol: "package-state-reverse-v1",
    },
    initialStores: params.selection,
    state: inventory.resources.map((resource, index) => {
      const image = resource.image;
      const before =
        image.kind === "missing"
          ? ({ kind: "missing" } as const)
          : image.kind === "file"
            ? ({
                kind: "file" as const,
                identity: image.identity,
                uid: image.uid,
                gid: image.gid,
                mode: image.mode,
                sha256: image.sha256,
                size: image.size,
              } as const)
            : image.kind === "directory"
              ? ({
                  kind: "directory" as const,
                  identity: image.identity,
                  uid: image.uid,
                  gid: image.gid,
                  mode: image.mode,
                } as const)
              : ({
                  kind: "symlink" as const,
                  identity: image.identity,
                  uid: image.uid,
                  gid: image.gid,
                  mode: image.mode,
                  target: image.target,
                } as const);
      const preparedEntry = preparedManifest.entries[index];
      const preparedFile =
        resource.sourcePath === params.state &&
        preparedEntry?.kind === "file" &&
        preparedEntry.sourcePath === resource.sourcePath
          ? preparedEntry
          : null;
      const changed =
        preparedFile !== null &&
        image.kind === "file" &&
        (preparedFile.sha256 !== image.sha256 || preparedFile.size !== image.size);
      const directory = path.join(
        params.stagingParent,
        `.openclaw-reverse-state-${params.operationId}`,
      );
      return {
        role: "state" as const,
        live: resource.sourcePath,
        parentIdentity: resource.ancestor.identity,
        before,
        desired:
          changed && preparedFile
            ? {
                kind: "file" as const,
                uid: image.kind === "file" ? image.uid : "0",
                gid: image.kind === "file" ? image.gid : "0",
                mode: preparedFile.mode,
                sha256: preparedFile.sha256,
                size: preparedFile.size,
              }
            : before,
        move: changed
          ? {
              directory,
              parentIdentity: identity(params.stagingParent),
              staged: path.join(directory, `${index}.next`),
              displaced: path.join(directory, `${index}.previous`),
            }
          : null,
      };
    }),
    packageResources: params.packageResources,
  } satisfies PackageActivationReversePreparation;
}
