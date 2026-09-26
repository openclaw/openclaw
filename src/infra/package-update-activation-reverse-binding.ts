import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  type PackageActivationDescriptor,
} from "./package-update-activation-journal.js";
import {
  assertLauncherImage,
  readPackageReverseImage,
  assertPackageReverseImage,
  reverseFileDigest,
  readReverseFile,
} from "./package-update-activation-reverse-files.js";
import {
  packageActivationReverseBindingSchema,
  type PackageActivationReverseBinding,
  type PackageActivationReverseImage,
} from "./package-update-activation-reverse-schema.js";
import { MAX_MANIFEST_BYTES } from "./update-recovery-backup-files.js";
import {
  readUpdateRecoverySourceAttestation,
  matchesUpdateRecoverySourceImage,
} from "./update-recovery-source-attestation.js";

type Entry = UpdateRecoveryBackupManifest["entries"][number];
function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
function readManifest(ref: PackageActivationReverseBinding["baseline"]) {
  const stat = fs.lstatSync(ref.manifestPath);
  if (
    ref.manifestPath !== path.join(ref.directory, "manifest.json") ||
    fs.realpathSync(ref.directory) !== ref.directory ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > MAX_MANIFEST_BYTES
  ) {
    throw new Error("Reverse generation manifest changed.");
  }
  const raw = readReverseFile(ref.manifestPath, MAX_MANIFEST_BYTES);
  if (createHash("sha256").update(raw).digest("hex") !== ref.manifestSha256) {
    throw new Error("Reverse generation manifest changed.");
  }
  const manifest = parseUpdateRecoveryBackupManifest(raw.toString("utf8"));
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const payload = path.join(ref.directory, entry.archivePath);
    const payloadStat = fs.lstatSync(payload);
    if (
      !payloadStat.isFile() ||
      payloadStat.nlink !== 1 ||
      fs.realpathSync(payload) !== payload ||
      payloadStat.size !== entry.size ||
      reverseFileDigest(payload) !== entry.sha256
    ) {
      throw new Error("Reverse generation payload changed.");
    }
  }
  return manifest;
}
function matchesEntry(image: PackageActivationReverseImage, entry: Entry) {
  if (image.kind !== entry.kind) {
    return false;
  }
  if (image.kind === "file" && entry.kind === "file") {
    return (
      image.sha256 === entry.sha256 &&
      image.size === entry.size &&
      image.mode === (entry.mode & 0o7777)
    );
  }
  if (image.kind === "directory" && entry.kind === "directory") {
    return image.mode === (entry.mode & 0o7777);
  }
  if (image.kind === "symlink" && entry.kind === "symlink") {
    return image.target === entry.target;
  }
  return image.kind === "missing";
}
/** Read the original immutable B/C/T payloads; never manufacture a generation from live state. */
export function readPackageReverseGenerations(
  refs: Pick<PackageActivationReverseBinding, "baseline" | "candidate" | "prepared">,
  runId: string,
  installRoot: string,
) {
  const baseline = readManifest(refs.baseline);
  const candidate = readManifest(refs.candidate);
  const prepared = readManifest(refs.prepared);
  if (
    baseline.generation?.kind !== "baseline" ||
    candidate.generation?.kind !== "candidate" ||
    prepared.generation?.kind !== "prepared" ||
    candidate.generation.baselineSha256 !== refs.baseline.manifestSha256 ||
    prepared.generation.baselineSha256 !== refs.baseline.manifestSha256 ||
    prepared.generation.candidateSha256 !== refs.candidate.manifestSha256
  ) {
    throw new Error("Reverse generations are not this B/C/T chain.");
  }
  for (const manifest of [baseline, candidate, prepared]) {
    if (
      manifest.runId !== runId ||
      manifest.installRoot !== installRoot ||
      !isDeepStrictEqual(manifest.databases, prepared.databases) ||
      !isDeepStrictEqual(manifest.configPaths, prepared.configPaths) ||
      !isDeepStrictEqual(manifest.roots, prepared.roots) ||
      !isDeepStrictEqual(manifest.excludedRoots, prepared.excludedRoots) ||
      !isDeepStrictEqual(manifest.protectedPaths, prepared.protectedPaths) ||
      manifest.stateDir !== prepared.stateDir ||
      manifest.configPath !== prepared.configPath
    ) {
      throw new Error("Reverse generations lost their original operation/resource ownership.");
    }
    if (
      !isDeepStrictEqual(
        manifest.entries.map((e) => e.sourcePath).toSorted(),
        prepared.entries.map((e) => e.sourcePath).toSorted(),
      )
    ) {
      throw new Error("Reverse generation resource inventory is not exhaustive.");
    }
  }
  return { baseline, candidate, prepared };
}
/** Validate all B/C/T identities, not just the resources that happen to differ. */
export function assertPackageReverseBinding(
  binding: PackageActivationReverseBinding,
  descriptor: PackageActivationDescriptor,
) {
  packageActivationReverseBindingSchema.parse(binding);
  if (
    binding.operationId !== descriptor.operationId ||
    binding.target.inventoryDigest !== descriptor.previous.digest ||
    binding.initialStores.installation.path !== descriptor.authority.installKey ||
    binding.initialStores.installation.identity !== descriptor.candidate.identity ||
    !isDeepStrictEqual(binding.initialStores.handoff, {
      databasePath: descriptor.authority.databasePath,
      databaseIdentity: descriptor.authority.databaseIdentity,
      parentIdentity: descriptor.authority.parentIdentity,
    })
  ) {
    throw new Error("Reverse binding names another operation, target, or initial store pair.");
  }
  const { admissionSha256: _admission, startupProtocol: _startup, ...selected } = binding.target;
  if (
    descriptor.originalRunId !== binding.runId ||
    !descriptor.previousRuntime ||
    !isDeepStrictEqual(selected, descriptor.previousRuntime)
  ) {
    throw new Error("Reverse target/run was not selected by this original journal.");
  }
  const refs = [binding.baseline, binding.candidate, binding.prepared];
  const anchor = resolvePackageActivationAnchor(descriptor.authority.installKey);
  const control = resolvePackageActivationControl(anchor);
  if (refs.some((ref) => [anchor, control].some((root) => inside(root, ref.directory)))) {
    throw new Error("Reverse generations cannot occupy journal-owned recovery artifacts.");
  }
  const { baseline, candidate, prepared } = readPackageReverseGenerations(
    binding,
    binding.runId,
    descriptor.authority.installKey,
  );
  const sourceAttestation = readUpdateRecoverySourceAttestation(binding.sourceAttestation, {
    runId: binding.runId,
    operationId: binding.operationId,
    candidateManifestSha256: binding.candidate.manifestSha256,
    entries: candidate.entries,
  });
  const sourceImages = new Map(sourceAttestation.resources.map((r) => [r.sourcePath, r]));
  const resources = binding.resources;
  const states = resources.filter((r) => r.role === "state");
  if (
    !isDeepStrictEqual(
      states.map((r) => r.live).toSorted(),
      prepared.entries.map((e) => e.sourcePath).toSorted(),
    )
  ) {
    throw new Error("Reverse publication omits or duplicates a captured resource.");
  }
  const global = prepared.databases?.find((database) => database.role === "global");
  const selectedState = states.find((resource) => resource.live === global?.path);
  if (
    !global ||
    !selectedState ||
    selectedState.before.kind !== "file" ||
    selectedState.before.identity !== binding.initialStores.state.databaseIdentity ||
    selectedState.parentIdentity !== binding.initialStores.state.parentIdentity
  ) {
    throw new Error("Reverse binding changed its selected global state generation.");
  }
  const packages = resources.filter((r) => r.role === "package");
  const packageResource = packages[0];
  if (
    packages.length !== 1 ||
    !packageResource ||
    packageResource.live !== descriptor.authority.installKey ||
    packageResource.before.kind !== "package" ||
    packageResource.after.kind !== "package" ||
    !isDeepStrictEqual(
      {
        digest: packageResource.before.digest,
        identity: packageResource.before.identity,
        version: packageResource.before.version,
      },
      descriptor.candidate,
    ) ||
    !isDeepStrictEqual(
      {
        digest: packageResource.after.digest,
        identity: packageResource.after.identity,
        version: packageResource.after.version,
      },
      descriptor.previous,
    )
  ) {
    throw new Error("Reverse publication must name the journal's exact package pair.");
  }
  const launchers = resources.filter((r) => r.role === "launcher");
  if (
    !isDeepStrictEqual(
      launchers.map((r) => r.live).toSorted(),
      descriptor.launchers.map((l) => path.join(descriptor.binDir, l.name)).toSorted(),
    )
  ) {
    throw new Error("Reverse publication launcher inventory is incomplete.");
  }
  for (const directory of prepared.entries.filter((entry) => entry.kind === "directory")) {
    const allowed = new Set(
      prepared.entries
        .filter((entry) => path.dirname(entry.sourcePath) === directory.sourcePath)
        .map((entry) => path.basename(entry.sourcePath)),
    );
    for (const name of fs.readdirSync(directory.sourcePath)) {
      const child = path.join(directory.sourcePath, name);
      if (
        !allowed.has(name) &&
        ![...prepared.excludedRoots, ...prepared.protectedPaths].some((excluded) =>
          inside(excluded, child),
        )
      ) {
        throw new Error("Reverse publication found an uncaptured resource.");
      }
    }
  }
  for (const entry of prepared.entries) {
    const resource = states.find((r) => r.live === entry.sourcePath)!;
    if (
      !matchesUpdateRecoverySourceImage(
        resource.before,
        sourceImages.get(entry.sourcePath)!,
        resource.parentIdentity,
      ) ||
      !matchesEntry(resource.after, entry)
    ) {
      throw new Error("Reverse resource does not publish C to verified T.");
    }
    if (
      resource.move &&
      (resource.before.kind === "directory" || resource.after.kind === "directory")
    ) {
      throw new Error("Reverse directory mutation requires its own migration contract.");
    }
    if ((entry.kind === "file" || entry.kind === "missing") && entry.sqlite) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (fs.lstatSync(`${entry.sourcePath}${suffix}`, { throwIfNoEntry: false })) {
          throw new Error("Reverse SQLite publication requires settled sidecars.");
        }
      }
    }
  }
  const paths = resources.flatMap((r) => [
    r.live,
    ...(r.move ? [r.move.staged, r.move.displaced] : []),
  ]);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Reverse publication paths alias another resource.");
  }
  for (const resource of resources) {
    if (!resource.move && !isDeepStrictEqual(resource.before, resource.after)) {
      throw new Error("Unchanged reverse resource has different generations.");
    }
    for (const file of [
      resource.live,
      ...(resource.move ? [resource.move.staged, resource.move.displaced] : []),
    ]) {
      if (
        file === descriptor.authority.databasePath ||
        (resource.move && inside(file, descriptor.authority.databasePath))
      ) {
        throw new Error("Reverse publication would consume the original authority database.");
      }
      if (
        refs.some(
          (r) => inside(r.directory, file) || (resource.move && inside(file, r.directory)),
        ) ||
        ([anchor, control].some((root) => inside(root, file)) &&
          !(
            resource.role === "package" &&
            ((file === resource.move?.staged && file === path.join(anchor, "previous")) ||
              (file === resource.move?.displaced && file === path.join(anchor, "candidate")))
          ) &&
          !(
            resource.role === "launcher" &&
            file === resource.move?.staged &&
            file === path.join(anchor, "previous-launchers", path.basename(resource.live))
          )) ||
        file === binding.sourceAttestation.path ||
        inside(file, binding.sourceAttestation.path) ||
        file === binding.target.nodePath ||
        inside(file, binding.target.nodePath)
      ) {
        throw new Error("Reverse publication would consume retained evidence or external Node.");
      }
    }
    if (resource.move) {
      const movingPaths = [resource.live, resource.move.staged, resource.move.displaced];
      if (movingPaths.some((a, i) => movingPaths.some((b, j) => i !== j && inside(a, b)))) {
        throw new Error("Reverse resource paths overlap themselves.");
      }
      if (
        [resource.move.staged, resource.move.displaced].some((file) =>
          prepared.roots.some((root) => inside(root, file)),
        )
      ) {
        throw new Error(
          "Reverse staging and displacement must remain outside captured state roots.",
        );
      }

      if (
        resources.some(
          (other) => other !== resource && movingPaths.some((file) => inside(file, other.live)),
        )
      ) {
        throw new Error("Reverse moving resource contains another live resource.");
      }
      if (resource.before.kind === "missing" && resource.after.kind === "missing") {
        throw new Error("Absent resource cannot have a publication move.");
      }
      if (
        resources.some(
          (other) =>
            other !== resource &&
            other.move &&
            [other.live, other.move.staged, other.move.displaced].some((file) =>
              [resource.live, resource.move!.staged, resource.move!.displaced].some(
                (own) => inside(file, own) || inside(own, file),
              ),
            ),
        )
      ) {
        throw new Error("Reverse moving resources overlap.");
      }
    }
  }
  // Publishing state before the package/launchers keeps the target startup fence
  // responsible for every partial generation; no unrecorded recursive restore.
  const firstPackage = resources.findIndex((r) => r.role !== "state");
  if (resources.slice(firstPackage).some((r) => r.role === "state")) {
    throw new Error("Reverse state resources must precede package publication.");
  }
  return { baseline, candidate, prepared, sourceAttestation };
}
export async function assertPackageReverseTarget(
  binding: PackageActivationReverseBinding,
  descriptor: PackageActivationDescriptor,
  packageRoot: string,
) {
  await assertPackageReverseImage(binding.target.nodePath, binding.target.node, descriptor, true);
  if (fs.realpathSync(binding.target.nodePath) !== binding.target.nodePath) {
    throw new Error("Selected reverse Node is not canonical.");
  }
  const entry = path.join(packageRoot, binding.target.entrypoint);
  if (
    !fs.lstatSync(entry).isFile() ||
    fs.realpathSync(entry) !== entry ||
    reverseFileDigest(entry) !== binding.target.entrypointSha256
  ) {
    throw new Error("Selected reverse entrypoint changed.");
  }
}
export async function assertReverseLauncher(file: string, expected: string | null) {
  assertLauncherImage(await readPackageReverseImage(file), expected);
}
