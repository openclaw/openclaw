import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationHelper,
  type PackageActivationIntent,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  assertPackageReverseBinding,
  readPackageReverseGenerations,
} from "./package-update-activation-reverse-binding.js";
import {
  readPackageReverseImage,
  syncPackageReverseInputs,
} from "./package-update-activation-reverse-files.js";
import {
  assertPackageReverseProgress,
  inspectPackageReverseTargetAndLaunchers,
  observePackageReverseResources,
} from "./package-update-activation-reverse-observation.js";
import {
  packageActivationReverseBindingSchema,
  packageActivationReversePreparationSchema,
  type PackageActivationReverseBinding,
  type PackageActivationReversePreparation,
  type PackageActivationReverseResource,
} from "./package-update-activation-reverse-schema.js";
import type { PackageActivationStatus } from "./package-update-activation-status.js";
import type { PackageReverseAuthority } from "./package-update-reverse-types.js";
import {
  assertUpdateRecoverySourceAttestationAdmission,
  assertUpdateRecoverySourceAttestationCurrent,
  readUpdateRecoverySourceAttestation,
} from "./update-recovery-source-attestation.js";

const desiredMatches = (
  image: PackageActivationReverseResource["after"],
  desired: PackageActivationReversePreparation["state"][number]["desired"],
) =>
  desired.kind === "missing"
    ? image.kind === "missing"
    : desired.kind === "file"
      ? image.kind === "file" &&
        image.uid === desired.uid &&
        image.gid === desired.gid &&
        image.mode === desired.mode &&
        image.sha256 === desired.sha256 &&
        image.size === desired.size
      : isDeepStrictEqual(image, desired);
export const assertPackageReversePreparation = (
  preparation: PackageActivationReversePreparation,
  record: PackageActivationRecord,
) => {
  if (
    preparation.operationId !== record.descriptor.operationId ||
    preparation.runId !== record.descriptor.originalRunId ||
    preparation.initialStores.installation.path !== record.descriptor.authority.installKey ||
    preparation.initialStores.installation.identity !== record.descriptor.candidate.identity ||
    !isDeepStrictEqual(preparation.initialStores.handoff, {
      databasePath: record.descriptor.authority.databasePath,
      databaseIdentity: record.descriptor.authority.databaseIdentity,
      parentIdentity: record.descriptor.authority.parentIdentity,
    }) ||
    preparation.packageResources.some((resource) => resource.role === "state")
  ) {
    throw new Error("Reverse preparation changed its original operation or selected stores.");
  }
  const generations = readPackageReverseGenerations(
    preparation,
    preparation.runId,
    record.descriptor.authority.installKey,
  );
  const entries = new Map(generations.prepared.entries.map((entry) => [entry.sourcePath, entry]));
  if (
    preparation.state.length !== entries.size ||
    new Set(preparation.state.map((resource) => resource.live)).size !== entries.size ||
    preparation.state.some((resource) => !entries.has(resource.live))
  ) {
    throw new Error("Reverse preparation state inventory is not exhaustive.");
  }
  const global = generations.prepared.databases?.find((database) => database.role === "global");
  const selectedState = preparation.state.find((resource) => resource.live === global?.path);
  if (
    !global ||
    !selectedState ||
    selectedState.before.kind !== "file" ||
    selectedState.before.identity !== preparation.initialStores.state.databaseIdentity ||
    selectedState.parentIdentity !== preparation.initialStores.state.parentIdentity
  ) {
    throw new Error("Reverse preparation changed its selected global state generation.");
  }
  return { generations, entries };
};
export async function materializePackageReversePreparation(
  params: {
    current: () => PackageActivationRecord;
    resuming?: boolean;
    assertAuthority: (
      binding: Pick<PackageActivationReversePreparation, "runId">,
      guard: PackageReverseAuthority,
    ) => void;
    assertExecutor: () => void;
    transition: (phase: "reverse-preparing", intent: PackageActivationIntent) => void;
    sealReverse: (binding: PackageActivationReverseBinding, assertExecutor: () => void) => void;
    publish: (guard: PackageReverseAuthority) => Promise<PackageActivationStatus>;
  },
  guard: PackageReverseAuthority,
) {
  let record = params.current();
  const preparation = packageActivationReversePreparationSchema.parse(
    record.descriptor.reversePreparation,
  );
  if (record.phase !== "reverse-preparing" || record.intent?.kind !== "reverse-prepare") {
    throw new Error("Operation is not a restartable reverse preparation.");
  }
  params.assertAuthority(preparation, guard);
  const { generations, entries } = assertPackageReversePreparation(preparation, record);
  await syncPackageReverseInputs(
    preparation.packageResources,
    () => params.assertAuthority(preparation, guard),
    (["baseline", "candidate", "prepared"] as const).map((kind) => ({
      directory: preparation[kind].directory,
      files: [
        preparation[kind].manifestPath,
        ...generations[kind].entries.flatMap((entry) =>
          entry.kind === "file" ? [path.join(preparation[kind].directory, entry.archivePath)] : [],
        ),
      ],
    })),
    [
      resolvePackageActivationHelper(
        resolvePackageActivationAnchor(record.descriptor.authority.installKey),
      ),
      preparation.sourceAttestation.path,
      preparation.target.nodePath,
      record.descriptor.authority.databasePath,
    ],
  );
  await guard.validateTarget(
    packageActivationReverseBindingSchema.parse({
      protocol: "package-state-reverse-v1",
      operationId: preparation.operationId,
      runId: preparation.runId,
      baseline: preparation.baseline,
      candidate: preparation.candidate,
      prepared: preparation.prepared,
      sourceAttestation: preparation.sourceAttestation,
      target: preparation.target,
      initialStores: preparation.initialStores,
      resources: [
        ...preparation.state.map((resource) => ({
          role: "state" as const,
          live: resource.live,
          parentIdentity: resource.parentIdentity,
          before: resource.before,
          after: resource.before,
          move: null,
        })),
        ...preparation.packageResources,
      ],
    }),
  );
  const sourceAttestation = readUpdateRecoverySourceAttestation(preparation.sourceAttestation, {
    runId: preparation.runId,
    operationId: preparation.operationId,
    candidateManifestSha256: preparation.candidate.manifestSha256,
    entries: generations.candidate.entries,
  });
  const assertCurrent = () => params.assertAuthority(preparation, guard);
  if (params.resuming) {
    await assertUpdateRecoverySourceAttestationCurrent(
      sourceAttestation,
      generations.candidate.entries,
      assertCurrent,
    );
  } else {
    await assertUpdateRecoverySourceAttestationAdmission(
      sourceAttestation,
      generations.candidate.entries,
      {
        assertCurrent,
        assertCapturedSource: guard.assertCapturedSource,
        sourceAttestation: preparation.sourceAttestation,
      },
    );
  }
  const resources: PackageActivationReverseResource[] = [];
  for (let index = 0; index < preparation.state.length; index += 1) {
    record = params.current();
    if (record.intent?.kind !== "reverse-prepare") {
      throw new Error("Reverse preparation progress is missing.");
    }
    const plan = preparation.state[index]!;
    if (index < record.intent.completed) {
      // Reconstruct the exact staged inode from durable path and expected image.
    } else if (index > record.intent.completed) {
      throw new Error("Reverse preparation skipped a state resource.");
    }
    if (!plan.move) {
      if (!desiredMatches(plan.before, plan.desired)) {
        throw new Error("Unchanged reverse preparation has a different target image.");
      }
      resources.push({
        role: "state",
        live: plan.live,
        parentIdentity: plan.parentIdentity,
        before: plan.before,
        after: plan.before,
        move: null,
      });
      if (index === record.intent.completed) {
        params.transition("reverse-preparing", {
          kind: "reverse-prepare",
          completed: index + 1,
          effect: null,
        });
      }
      continue;
    }
    const entry = entries.get(plan.live);
    if (!entry || (entry.kind !== "file" && entry.kind !== "missing")) {
      throw new Error("Reverse preparation target is not a file generation.");
    }
    if (index === record.intent.completed && record.intent.effect === null) {
      params.transition("reverse-preparing", {
        kind: "reverse-prepare",
        completed: index,
        effect: "create",
      });
    }
    assertCurrent();
    const parentStat = fs.lstatSync(path.dirname(plan.move.directory), { bigint: true });
    if (`${parentStat.dev}:${parentStat.ino}` !== plan.move.parentIdentity) {
      throw new Error("Reverse staging parent changed.");
    }
    const directoryStat = fs.lstatSync(plan.move.directory, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!directoryStat) {
      await fsp.mkdir(plan.move.directory, { mode: 0o700 });
      requireDirectorySync(
        await syncDirectory(path.dirname(plan.move.directory)),
        "Reverse staging parent",
      );
    } else if (
      !directoryStat.isDirectory() ||
      (process.getuid && directoryStat.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (directoryStat.mode & 0o077n) !== 0n)
    ) {
      throw new Error("Reverse staging directory is not private and owned.");
    }
    const allowed = new Set(
      preparation.state.flatMap((resource) =>
        resource.move
          ? [path.basename(resource.move.staged), path.basename(resource.move.displaced)]
          : [],
      ),
    );
    if (fs.readdirSync(plan.move.directory).some((name) => !allowed.has(name))) {
      throw new Error("Reverse staging directory contains an unowned entry.");
    }
    record = params.current();
    if (
      record.intent?.kind === "reverse-prepare" &&
      record.intent.completed === index &&
      record.intent.effect !== "copy"
    ) {
      params.transition("reverse-preparing", {
        kind: "reverse-prepare",
        completed: index,
        effect: "copy",
      });
    }
    record = params.current();
    let stagedStat = fs.lstatSync(plan.move.staged, { bigint: true, throwIfNoEntry: false });
    if (
      plan.desired.kind === "file" &&
      stagedStat &&
      record.intent?.kind === "reverse-prepare" &&
      record.intent.completed === index &&
      record.intent.effect === "copy" &&
      !desiredMatches(await readPackageReverseImage(plan.move.staged), plan.desired)
    ) {
      if (
        !stagedStat.isFile() ||
        stagedStat.nlink !== 1n ||
        (process.getuid && stagedStat.uid !== BigInt(process.getuid()))
      ) {
        throw new Error("Incomplete staged recovery resource is not an owned regular file.");
      }
      const currentStat = fs.lstatSync(plan.move.staged, { bigint: true });
      if (currentStat.dev !== stagedStat.dev || currentStat.ino !== stagedStat.ino) {
        throw new Error("Incomplete staged recovery resource changed before cleanup.");
      }
      assertCurrent();
      await fsp.unlink(plan.move.staged);
      requireDirectorySync(await syncDirectory(plan.move.directory), "Reverse staged cleanup");
      assertCurrent();
      stagedStat = undefined;
    }
    if (plan.desired.kind === "file" && !stagedStat) {
      if (entry.kind !== "file") {
        throw new Error("Prepared manifest lost the staged file payload.");
      }
      const payload = path.join(preparation.prepared.directory, entry.archivePath);
      await fsp.copyFile(payload, plan.move.staged, fs.constants.COPYFILE_EXCL);
      const output = await fsp.open(plan.move.staged, "r+");
      try {
        await output.chown(Number(plan.desired.uid), Number(plan.desired.gid));
        await output.chmod(plan.desired.mode);
        await output.sync();
      } finally {
        await output.close();
      }
      requireDirectorySync(await syncDirectory(plan.move.directory), "Reverse staged state");
    }
    if (
      plan.desired.kind === "missing" &&
      fs.lstatSync(plan.move.staged, { throwIfNoEntry: false })
    ) {
      throw new Error("Missing reverse target unexpectedly has a staged file.");
    }
    const after = await readPackageReverseImage(plan.move.staged);
    if (!desiredMatches(after, plan.desired)) {
      throw new Error("Staged recovery resource does not match verified T.");
    }
    const stagingStat = fs.lstatSync(plan.move.directory, { bigint: true });
    resources.push({
      role: "state",
      live: plan.live,
      parentIdentity: plan.parentIdentity,
      before: plan.before,
      after,
      move: {
        staged: plan.move.staged,
        stagedParentIdentity: `${stagingStat.dev}:${stagingStat.ino}`,
        displaced: plan.move.displaced,
        displacedParentIdentity: `${stagingStat.dev}:${stagingStat.ino}`,
      },
    });
    record = params.current();
    if (record.intent?.kind === "reverse-prepare" && record.intent.completed === index) {
      params.transition("reverse-preparing", {
        kind: "reverse-prepare",
        completed: index + 1,
        effect: null,
      });
    }
  }
  const binding = packageActivationReverseBindingSchema.parse({
    protocol: "package-state-reverse-v1",
    operationId: preparation.operationId,
    runId: preparation.runId,
    baseline: preparation.baseline,
    candidate: preparation.candidate,
    prepared: preparation.prepared,
    sourceAttestation: preparation.sourceAttestation,
    target: preparation.target,
    initialStores: preparation.initialStores,
    resources: [...resources, ...preparation.packageResources],
  });
  assertPackageReverseBinding(binding, params.current().descriptor);
  const provisional: PackageActivationRecord = {
    ...params.current(),
    phase: "reverse-in-progress",
    descriptor: {
      ...params.current().descriptor,
      reversePreparation: undefined,
      reverse: binding,
    },
    intent: { kind: "reverse", direction: "reverse", completed: 0, effect: null },
  };
  const rows = await observePackageReverseResources(provisional);
  assertPackageReverseProgress(provisional, rows);
  await inspectPackageReverseTargetAndLaunchers(provisional, rows);
  await syncPackageReverseInputs(
    binding.resources,
    () => params.assertAuthority(binding, guard),
    (["baseline", "candidate", "prepared"] as const).map((kind) => ({
      directory: binding[kind].directory,
      files: [binding[kind].manifestPath],
    })),
    [binding.sourceAttestation.path, binding.target.nodePath],
  );
  params.assertAuthority(binding, guard);
  params.sealReverse(binding, params.assertExecutor);
  return { binding, status: await params.publish(guard) };
}
