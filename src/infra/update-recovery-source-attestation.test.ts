import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { resolveSqliteFilesystemPath } from "./node-sqlite.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationHelper,
} from "./package-update-activation-journal.js";
import type {
  PackageActivationDescriptor,
  PackageActivationRecord,
} from "./package-update-activation-journal.js";
import { assertPackageReverseBinding } from "./package-update-activation-reverse-binding.js";
import {
  readPackageReverseImage,
  reverseFileDigest,
} from "./package-update-activation-reverse-files.js";
import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import { createPackageActivationReverseOwner } from "./package-update-activation-reverse.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  acquireStateDatabaseHandleExclusion,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";
import {
  assertUpdateRecoverySourceAttestationCurrent,
  assertUpdateRecoverySourceAttestationAdmission,
} from "./update-recovery-source-attestation.js";
import { sourceInventoryFixture } from "./update-recovery-source.test-support.js";

// Only executor registration and journal persistence are doubled in owner tests.
// Attestation input is synthetic; inventory validation, immutable manifests and filesystem moves are real.
const executorAuthority = vi.hoisted(() => vi.fn<() => PackageActivationDescriptor["authority"]>());
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  captureUpdateCommandExecutorAuthority: executorAuthority,
  captureUpdateCommandRecoveryGenerationAuthority: (fence: { assertCurrent: () => void }) =>
    fence.assertCurrent,
}));

// Native SQLite capture versus the actual B/C/T binding validator. The package,
// runtime and manifest envelope are controlled. Owner tests double executor registration
// and journal persistence, but perform real state/package filesystem moves. No original
// executor, startup, Worker, Doctor, or installed no-loss acceptance is claimed.
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (file: string) => {
  const s = fs.statSync(file, { bigint: true });
  return `${s.dev}:${s.ino}`;
};
const rows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    return db.prepare("SELECT rowid,value FROM acknowledged ORDER BY rowid").all();
  } finally {
    db.close();
  }
};
it.each([
  { journalMode: "DELETE", flow: "reject" },
  { journalMode: "WAL", flow: "reject" },
  { journalMode: "DELETE", flow: "resume" },
  { journalMode: "DELETE", flow: "admit" },
  { journalMode: "DELETE", flow: "late-revoke" },
  { journalMode: "DELETE", flow: "pre-publish-revoke" },
  { journalMode: "DELETE", flow: "effect-revoke" },
] as const)(
  "verifies $journalMode source binding and owner (flow: $flow)",
  async ({ journalMode, flow }) => {
    const resume = flow === "resume";
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "candidate-image-")));
    fs.chmodSync(root, 0o700);
    try {
      const stateDir = path.join(root, "state");
      const installation = path.join(root, "installation");
      const coordinator = path.join(root, "coordinator");
      const staging = path.join(root, "staging");
      for (const dir of [stateDir, installation, coordinator, staging]) {
        fs.mkdirSync(dir, { mode: 0o700 });
      }
      const privateTmp = path.join(root, "private-tmp");
      fs.mkdirSync(privateTmp, { mode: 0o700 });
      const handoff = installPrivateUpdateHandoffStore(privateTmp);
      handoff.assertDatabasePath(handoff.databasePath);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "config.json"));
      fs.mkdirSync(path.join(installation, "dist"));
      fs.writeFileSync(
        path.join(installation, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2.0.0" }),
      );
      fs.writeFileSync(path.join(installation, "dist/index.js"), "entry");
      const previousPackage = path.join(root, "previous-package");
      fs.cpSync(installation, previousPackage, { recursive: true });
      fs.writeFileSync(
        path.join(previousPackage, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      );
      const state = path.join(stateDir, "global.sqlite");
      const config = path.join(stateDir, "config.json");
      const db = new DatabaseSync(state);
      try {
        db.exec(`PRAGMA journal_mode=${journalMode}; CREATE TABLE acknowledged(value TEXT)`);
        db.prepare("INSERT INTO acknowledged(rowid,value) VALUES (37,?)").run(
          "newer acknowledged write",
        );
      } finally {
        db.close();
      }
      fs.chmodSync(state, 0o600);
      const originalBytes = fs.readFileSync(state);
      const before = await readPackageReverseImage(state);
      if (before.kind !== "file") {
        throw new Error("Missing state fixture");
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(fs.existsSync(state + suffix)).toBe(false);
      }
      const operationId = randomUUID();
      const runId = randomUUID();
      const references: PackageActivationReverseBinding["baseline"][] = [];
      for (const kind of ["baseline", "candidate", "prepared"] as const) {
        const directory = path.join(root, kind);
        fs.mkdirSync(path.join(directory, "payload"), { recursive: true, mode: 0o700 });
        fs.copyFileSync(state, path.join(directory, "payload/0"));
        const manifest: UpdateRecoveryBackupManifest = {
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
          databases: [{ path: state, role: "global" }],
          runId,
          installRoot: installation,
          stateDir,
          configPath: config,
          configPaths: [config],
          creator: { host: "private-test", pid: process.pid, startIdentity: "1" },
          drivers: [],
          createdAt: new Date().toISOString(),
          roots: [stateDir],
          excludedRoots: [],
          protectedPaths: [],
          entries: [
            { kind: "directory", sourcePath: stateDir, mode: 0o700 },
            { kind: "missing", sourcePath: config, sqlite: false, directory: false },
            {
              kind: "file",
              sourcePath: state,
              archivePath: "payload/0",
              sqlite: true,
              mode: 0o600,
              sha256: reverseFileDigest(state),
              size: fs.statSync(state).size,
            },
          ],
        };
        const manifestPath = path.join(directory, "manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
        references.push({
          directory,
          manifestPath,
          manifestSha256: reverseFileDigest(manifestPath),
        });
      }
      const nodePath = path.join(root, "controlled-node");
      fs.writeFileSync(nodePath, "never executed", { mode: 0o600 });
      const node = await readPackageReverseImage(nodePath);
      if (node.kind !== "file") {
        throw new Error("Missing node fixture");
      }
      const runtime = {
        packageManifestSha256: hash("pkg"),
        buildInfoSha256: hash("build"),
        buildId: "controlled",
        sourceCommit: "a".repeat(40),
        inventoryDigest: hash("pkg"),
        nodeVersion: process.version,
        nodePath,
        node,
        entrypoint: "dist/index.js",
        entrypointSha256: hash("entry"),
      };
      const pkg = await readPackageReverseImage(installation, installation);
      if (pkg.kind !== "package") {
        throw new Error("Missing package fixture");
      }
      const previousPkg = await readPackageReverseImage(previousPackage, installation);
      if (previousPkg.kind !== "package") {
        throw new Error("Missing previous package fixture");
      }
      runtime.inventoryDigest = previousPkg.digest;
      const descriptor: PackageActivationDescriptor = {
        layout: "external-helper",
        version: 1,
        operationId,
        originalRunId: runId,
        previousRuntime: runtime,
        authority: {
          databasePath: path.join(root, "not-opened-handoff.sqlite"),
          databaseIdentity: identity(root),
          parentIdentity: identity(root),
          installKey: installation,
          owner: "controlled",
        },
        anchorIdentity: identity(root),
        journalIdentity: identity(root),
        journalParentIdentity: identity(root),
        parentIdentity: identity(root),
        binDir: root,
        binIdentity: identity(root),
        originalStageRoot: installation,
        previous: {
          identity: previousPkg.identity,
          digest: previousPkg.digest,
          version: previousPkg.version,
        },
        candidate: { identity: pkg.identity, digest: pkg.digest, version: pkg.version },
        launcherRootIdentity: identity(root),
        previousLauncherRootIdentity: null,
        helperIdentity: identity(root),
        preparation: [],
        helperDigest: hash("helper"),
        launchers: [],
      };
      const helper = resolvePackageActivationHelper(resolvePackageActivationAnchor(installation));
      fs.mkdirSync(path.dirname(helper), { recursive: true, mode: 0o700 });
      fs.writeFileSync(helper, "helper", { mode: 0o600 });
      fs.writeFileSync(descriptor.authority.databasePath, "controlled authority, never opened", {
        mode: 0o600,
      });
      const staged = path.join(staging, "next.sqlite");
      fs.copyFileSync(path.join(references[2]!.directory, "payload/0"), staged);
      const binding: PackageActivationReverseBinding = {
        protocol: "package-state-reverse-v1",
        operationId,
        runId,
        baseline: references[0]!,
        candidate: references[1]!,
        prepared: references[2]!,
        sourceAttestation: {
          path: path.join(root, "source-attestation.json"),
          sha256: "0".repeat(64),
        },
        target: {
          ...runtime,
          admissionSha256: hash("controlled-admission"),
          startupProtocol: "package-state-reverse-v1",
        },
        initialStores: {
          privateRoot: { path: root, identity: identity(root) },
          installation: { path: installation, identity: pkg.identity },
          handoff: {
            databasePath: descriptor.authority.databasePath,
            databaseIdentity: descriptor.authority.databaseIdentity,
            parentIdentity: descriptor.authority.parentIdentity,
          },
          state: {
            databasePath: state,
            databaseIdentity: before.identity,
            parentIdentity: identity(stateDir),
          },
        },
        resources: [
          {
            role: "state",
            live: stateDir,
            parentIdentity: identity(root),
            before: await readPackageReverseImage(stateDir),
            after: await readPackageReverseImage(stateDir),
            move: null,
          },
          {
            role: "state",
            live: config,
            parentIdentity: identity(stateDir),
            before: { kind: "missing" },
            after: { kind: "missing" },
            move: null,
          },
          {
            role: "state",
            live: state,
            parentIdentity: identity(stateDir),
            before,
            after: await readPackageReverseImage(staged),
            move: {
              staged,
              displaced: path.join(staging, "displaced.sqlite"),
              stagedParentIdentity: identity(staging),
              displacedParentIdentity: identity(staging),
            },
          },
          {
            role: "package",
            live: installation,
            parentIdentity: identity(root),
            before: pkg,
            after: previousPkg,
            move: {
              staged: previousPackage,
              displaced: path.join(root, "displaced-package"),
              stagedParentIdentity: identity(root),
              displacedParentIdentity: identity(root),
            },
          },
        ],
      };
      const payload = path.join(binding.candidate.directory, "payload/0");
      fs.unlinkSync(payload);
      await withStateDatabaseCoordinatorRuntimeDirectory(
        { directory: coordinator, keepAlive: false },
        async () => {
          const exclusion = acquireStateDatabaseHandleExclusion({ databasePath: state });
          try {
            await exclusion.runWithSourceReads(async (assertCurrent) => {
              const inventory = sourceInventoryFixture({
                runId,
                operationId,
                resources: [
                  { sourcePath: stateDir },
                  { sourcePath: config },
                  { sourcePath: state, sqlite: true },
                ],
              });
              // The exact preserving branch used by capture under native source
              // exclusion. Explicit task-private staging avoids any ambient temp root.
              const frozen = prepareSqliteReadOnlyLocationSyncInProcess(
                state,
                binding.candidate.directory,
              );
              try {
                await createVerifiedSqliteSnapshot({
                  sourcePath: resolveSqliteFilesystemPath(frozen.location),
                  targetPath: payload,
                  preserveRowIds: true,
                  beforePublish: assertCurrent,
                });
              } finally {
                expect(frozen.cleanup()).toBe(true);
              }

              expect(rows(payload)).toEqual([{ rowid: 37, value: "newer acknowledged write" }]);
              const candidate = JSON.parse(fs.readFileSync(binding.candidate.manifestPath, "utf8"));
              candidate.entries[2].sha256 = reverseFileDigest(payload);
              candidate.entries[2].size = fs.statSync(payload).size;
              fs.writeFileSync(binding.candidate.manifestPath, JSON.stringify(candidate));
              binding.candidate.manifestSha256 = reverseFileDigest(binding.candidate.manifestPath);
              const prepared = JSON.parse(fs.readFileSync(binding.prepared.manifestPath, "utf8"));
              prepared.generation.candidateSha256 = binding.candidate.manifestSha256;
              // T and its staging already contain all acknowledged rows, unchanged.
              expect(rows(staged)).toEqual(rows(payload));
              fs.writeFileSync(binding.prepared.manifestPath, JSON.stringify(prepared));
              binding.prepared.manifestSha256 = reverseFileDigest(binding.prepared.manifestPath);
              expect(fs.readFileSync(state)).toEqual(originalBytes);
              expect(await readPackageReverseImage(state)).toEqual(before);
              for (const suffix of ["-wal", "-shm", "-journal"]) {
                expect(fs.existsSync(state + suffix)).toBe(false);
              }
              expect(reverseFileDigest(payload)).not.toBe(
                before.kind === "file" ? before.sha256 : "",
              );
              const attestation = {
                protocol: "update-recovery-source-v1" as const,
                runId: inventory.runId,
                operationId: inventory.operationId,
                candidateManifestSha256: binding.candidate.manifestSha256,
                resources: inventory.resources,
              };
              const raw = JSON.stringify(attestation) + "\n";
              await assertUpdateRecoverySourceAttestationCurrent(
                attestation,
                candidate.entries,
                assertCurrent,
              );
              fs.writeFileSync(binding.sourceAttestation.path, raw, { mode: 0o600, flag: "wx" });
              binding.sourceAttestation.sha256 = hash(raw);
              expect(() => assertPackageReverseBinding(binding, descriptor)).not.toThrow();
              const captured = assertPackageReverseBinding(binding, descriptor).sourceAttestation;
              expect(captured.resources).toEqual(inventory.resources);
              // Neither a fabricated snapshot-as-source image nor a substituted payload is accepted.
              const wrong = structuredClone(binding);
              const wrongState = wrong.resources.find((r) => r.live === state)!;
              if (wrongState.before.kind !== "file") {
                throw new Error("Missing physical source");
              }
              wrongState.before.sha256 = reverseFileDigest(payload);
              expect(() => assertPackageReverseBinding(wrong, descriptor)).toThrow(
                "C to verified T",
              );
              const capturedRef = { ...binding.sourceAttestation };
              let proofHeld = true;
              const assertCapturedSource = (
                ref: PackageActivationReverseBinding["sourceAttestation"],
                value: unknown,
              ) => {
                assertCurrent();
                if (!proofHeld) {
                  throw new Error("Capture proof revoked");
                }
                if (
                  !isDeepStrictEqual(ref, capturedRef) ||
                  !isDeepStrictEqual(value, attestation)
                ) {
                  throw new Error("Fabricated capture proof");
                }
              };
              await assertUpdateRecoverySourceAttestationAdmission(attestation, candidate.entries, {
                assertCurrent,
                assertCapturedSource,
                sourceAttestation: binding.sourceAttestation,
              });
              await expect(
                assertUpdateRecoverySourceAttestationAdmission(attestation, candidate.entries, {
                  assertCurrent,
                  sourceAttestation: binding.sourceAttestation,
                }),
              ).rejects.toThrow("proof is missing");
              const fabricated = structuredClone(attestation);
              const fabricatedImage = fabricated.resources.find(
                (r) => r.sourcePath === state,
              )!.image;
              if (fabricatedImage.kind !== "file") {
                throw new Error("Missing captured file");
              }
              fabricatedImage.sha256 = reverseFileDigest(payload);
              await expect(
                assertUpdateRecoverySourceAttestationAdmission(fabricated, candidate.entries, {
                  assertCurrent,
                  assertCapturedSource,
                  sourceAttestation: binding.sourceAttestation,
                }),
              ).rejects.toThrow("Fabricated capture proof");
              const oldPin = binding.sourceAttestation.sha256;
              binding.sourceAttestation.sha256 = "f".repeat(64);
              expect(() => assertPackageReverseBinding(binding, descriptor)).toThrow(
                "digest changed",
              );
              binding.sourceAttestation.sha256 = oldPin;
              const originalPayload = fs.readFileSync(payload);
              fs.appendFileSync(payload, "not the verified C payload");
              expect(() => assertPackageReverseBinding(binding, descriptor)).toThrow(
                "payload changed",
              );
              fs.writeFileSync(payload, originalPayload);
              executorAuthority.mockReturnValue(descriptor.authority);
              let record: PackageActivationRecord = {
                revision: 0,
                phase: "publication-complete",
                intent: null,
                descriptor,
                publications: [],
              };
              const transition = vi.fn<
                Parameters<typeof createPackageActivationReverseOwner>[0]["transition"]
              >((phase, intent, publications, reverse) => {
                assertCurrent();
                record = {
                  ...record,
                  revision: record.revision + 1,
                  phase,
                  intent,
                  publications: publications ?? record.publications,
                  descriptor: reverse ? { ...record.descriptor, reverse } : record.descriptor,
                };
                if (reverse && flow === "pre-publish-revoke") {
                  proofHeld = false;
                }
              });
              const unexpectedJournalWrite = () => {
                throw new Error("Unexpected direct journal write");
              };
              const journal = {
                read: () => record,
                readForRecovery: async () => unexpectedJournalWrite(),
                replaceCompleted: unexpectedJournalWrite,
                prepareReverse: unexpectedJournalWrite,
                sealReverse: unexpectedJournalWrite,
                transition: unexpectedJournalWrite,
                assertCurrent: (expected: PackageActivationRecord) => {
                  assertCurrent();
                  expect(expected).toBe(record);
                },
              };
              const ownerParams = {
                journal,
                current: () => record,
                transition,
                prepareReverse: unexpectedJournalWrite,
                sealReverse: unexpectedJournalWrite,
                assertCurrent,
                verifyClosure: async () => {
                  assertCurrent();
                  if (
                    flow === "effect-revoke" &&
                    record.intent?.kind === "reverse" &&
                    record.intent.effect === "displace"
                  ) {
                    proofHeld = false;
                  }
                },
                verifyForward: async () => {
                  assertCurrent();
                },
                fence: { assertCurrent },
              };
              const authority = {
                assertCurrent,
                assertWritersSettled: assertCurrent,
                validateTarget: vi.fn(async () => {
                  assertCurrent();
                  if (flow === "late-revoke") {
                    proofHeld = false;
                  }
                }),
                beforeStatePublication: vi.fn(assertCurrent),
              };
              if (resume) {
                // Durable intent already records displacement of C. An attempted
                // fresh source capture would fail because live C is now absent.
                const resource = binding.resources.find((r) => r.live === state)!;
                if (!resource.move) {
                  throw new Error("Missing reverse move");
                }
                fs.renameSync(state, resource.move.displaced);
                record = {
                  ...record,
                  phase: "reverse-in-progress",
                  descriptor: { ...descriptor, reverse: binding },
                  intent: {
                    kind: "reverse",
                    direction: "reverse",
                    completed: 2,
                    effect: "displace",
                  },
                };
                const recapture = vi.fn(() => {
                  throw new Error("Must not recapture partial C");
                });
                const owner = createPackageActivationReverseOwner({
                  ...ownerParams,
                  resuming: true,
                });
                await expect(
                  owner.resumeReverse({ ...authority, assertCapturedSource: recapture }),
                ).resolves.toMatchObject({ phase: "reverse-complete" });
                expect(recapture).not.toHaveBeenCalled();
                expect(authority.beforeStatePublication).not.toHaveBeenCalled();
                expect(transition).toHaveBeenCalled();
                expect(record.descriptor.reverse?.sourceAttestation).toEqual(
                  binding.sourceAttestation,
                );
                expect(await readPackageReverseImage(state)).toEqual(resource.after);
                expect(await readPackageReverseImage(resource.move.displaced)).toEqual(before);
                expect(rows(state)).toEqual([{ rowid: 37, value: "newer acknowledged write" }]);
                return;
              }
              const owner = createPackageActivationReverseOwner(ownerParams);
              if (
                flow === "admit" ||
                flow === "late-revoke" ||
                flow === "pre-publish-revoke" ||
                flow === "effect-revoke"
              ) {
                const admission = owner.reverse(binding, { ...authority, assertCapturedSource });
                if (flow === "admit") {
                  await expect(admission).resolves.toMatchObject({ phase: "reverse-complete" });
                  const pin = transition.mock.calls.find((call) => call[3]);
                  expect(pin?.[3]?.sourceAttestation).toEqual(capturedRef);
                  expect(record.descriptor.reverse?.sourceAttestation).toEqual(capturedRef);
                  expect(authority.beforeStatePublication).toHaveBeenCalledOnce();
                  expect(rows(state)).toEqual([{ rowid: 37, value: "newer acknowledged write" }]);
                  expect(
                    await readPackageReverseImage(path.join(staging, "displaced.sqlite")),
                  ).toEqual(before);
                } else {
                  await expect(admission).rejects.toThrow("Capture proof revoked");
                  expect(authority.validateTarget).toHaveBeenCalled();
                  if (flow === "effect-revoke") {
                    expect(record.phase).toBe("reverse-in-progress");
                    expect(record.intent).toMatchObject({ kind: "reverse", effect: "displace" });
                    expect(record.descriptor.reverse?.sourceAttestation).toEqual(capturedRef);
                  } else {
                    expect(transition).toHaveBeenCalledTimes(flow === "late-revoke" ? 0 : 1);
                  }
                  if (flow === "pre-publish-revoke") {
                    expect(record.descriptor.reverse?.sourceAttestation).toEqual(capturedRef);
                  }
                  expect(authority.beforeStatePublication).not.toHaveBeenCalled();
                  expect(fs.readFileSync(state)).toEqual(originalBytes);
                  expect(fs.existsSync(path.join(staging, "displaced.sqlite"))).toBe(false);
                }
                return;
              }

              await expect(owner.reverse(binding, authority)).rejects.toThrow("proof is missing");
              const rejectProof = vi.fn(() => {
                throw new Error("Rejected original capture");
              });
              await expect(
                owner.reverse(binding, { ...authority, assertCapturedSource: rejectProof }),
              ).rejects.toThrow("Rejected original capture");
              const reissued = structuredClone(binding);
              reissued.sourceAttestation.path = path.join(root, "reissued-source.json");
              fs.writeFileSync(reissued.sourceAttestation.path, raw, { flag: "wx", mode: 0o600 });
              await expect(
                owner.reverse(reissued, { ...authority, assertCapturedSource }),
              ).rejects.toThrow("Fabricated capture proof");
              expect(rejectProof).toHaveBeenCalledOnce();
              expect(transition).not.toHaveBeenCalled();
              expect(authority.validateTarget).not.toHaveBeenCalled();
              expect(authority.beforeStatePublication).not.toHaveBeenCalled();
              expect(fs.readFileSync(state)).toEqual(originalBytes);
              expect(fs.existsSync(path.join(staging, "displaced.sqlite"))).toBe(false);
              // A newer live write cannot be recaptured to excuse this sealed source inventory.
              const newer = new DatabaseSync(state);
              try {
                newer
                  .prepare("INSERT INTO acknowledged(rowid,value) VALUES (38,?)")
                  .run("later committed row");
              } finally {
                newer.close();
              }
              await expect(
                assertUpdateRecoverySourceAttestationCurrent(
                  attestation,
                  candidate.entries,
                  assertCurrent,
                ),
              ).rejects.toThrow("changed after capture");
              expect(rows(state)).toEqual([
                { rowid: 37, value: "newer acknowledged write" },
                { rowid: 38, value: "later committed row" },
              ]);
            });
          } finally {
            exclusion.release();
          }
        },
      );
    } finally {
      executorAuthority.mockReset();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
