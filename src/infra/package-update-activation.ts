import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { hasErrnoCode } from "./errors.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  PACKAGE_ACTIVATION_JOURNAL,
  resolvePackageActivationAnchor,
  type PackageActivationIntent,
  type PackageActivationJournal,
  type PackageActivationPhase,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  preparePackageActivationJournal,
  type PackageActivationPreparation,
} from "./package-update-activation-prepare.js";
import { PACKAGE_ACTIVATION_HELPER } from "./package-update-activation-runtime-assets.js";
import {
  activateStagedNpmPackageRoot,
  copyPackagePathEntry,
  packagePathEntryExists,
  removePackagePath,
} from "./package-update-filesystem.js";
import {
  createPackageIntegrityReader,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationOptions } from "./package-update-activation-prepare.js";
export type PackageActivationStatus = {
  phase: PackageActivationPhase;
  operationId: string;
  installKey: string;
};
const status = (record: PackageActivationRecord): PackageActivationStatus => ({
  phase: record.phase,
  operationId: record.descriptor.operationId,
  installKey: record.descriptor.authority.installKey,
});

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  try {
    fs.lstatSync(anchor);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (
    !fs.existsSync(path.join(anchor, PACKAGE_ACTIVATION_HELPER)) ||
    !fs.existsSync(path.join(anchor, PACKAGE_ACTIVATION_JOURNAL))
  ) {
    throw new Error(
      `Incomplete recovery artifacts require operator inspection: ${anchor}. The next mutable update is blocked.`,
    );
  }
  const record = openPackageActivationJournal(anchor).read();
  if (
    record.phase !== "publication-complete" ||
    record.descriptor.authority.installKey !== installKey
  ) {
    throw new Error("Package publication is incomplete; its original continuation cannot run.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return record.descriptor.authority;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence },
): void {
  const authority = readPackageActivationContinuation(installKey);
  if (!authority) {
    return;
  }
  if (
    options?.continuation &&
    isDeepStrictEqual(authority, captureUpdateCommandExecutorAuthority(options.continuation))
  ) {
    return;
  }
  const anchor = resolvePackageActivationAnchor(installKey);
  throw new Error(
    `Package publication recovery is pending. Run an external Node with ${path.join(anchor, PACKAGE_ACTIVATION_HELPER)} status, then repair or retire; keep other package managers stopped.`,
  );
}

function createPublicationOwner(
  anchor: string,
  journal: PackageActivationJournal,
  assertion: () => void,
) {
  let record = journal.read();
  const descriptor = record.descriptor;
  let retirementSelected: "previous" | "candidate" | undefined;
  const live = descriptor.authority.installKey;
  const root = (name: string) => path.join(anchor, name);
  const helperIdentity = packageActivationIdentity(root(PACKAGE_ACTIVATION_HELPER), false);
  const artifactNames = [
    "previous",
    "candidate",
    "previous.candidate",
    "launchers",
    "previous-launchers",
    PACKAGE_ACTIVATION_HELPER,
    PACKAGE_ACTIVATION_JOURNAL,
  ];
  const assertInventory = (allowed = artifactNames) => {
    const entries = fs.readdirSync(anchor);
    if (entries.some((name) => !allowed.includes(name))) {
      throw new Error("Unknown package recovery artifacts require operator inspection.");
    }
  };
  const entryIdentity = (file: string, directory: boolean | "launcher") => {
    try {
      return packageActivationIdentity(file, directory);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  };
  const selectedLauncherIdentity = (
    entry: (typeof descriptor.launchers)[number],
    selected: "previous" | "candidate",
  ) => {
    if (selected === "previous" && entry.previous === null) {
      return null;
    }
    return record.phase === "aborted"
      ? entry.previousIdentity
      : record.publications.find((published) => published.name === entry.name)?.identity;
  };
  const assertSelectedLaunchers = (selected: "previous" | "candidate") => {
    for (const entry of descriptor.launchers) {
      if (
        entryIdentity(path.join(descriptor.binDir, entry.name), "launcher") !==
        selectedLauncherIdentity(entry, selected)
      ) {
        throw new Error("Selected package launcher identity changed.");
      }
    }
  };
  const assertCurrent = () => {
    assertion();
    journal.assertCurrent(record);
    if (packageActivationIdentity(descriptor.binDir, true) !== descriptor.binIdentity) {
      throw new Error("Package launcher parent changed");
    }
    if (
      retirementSelected &&
      packageActivationIdentity(live, true) !== descriptor[retirementSelected].identity
    ) {
      throw new Error("Selected package changed during retirement.");
    }
    if (retirementSelected) {
      assertSelectedLaunchers(retirementSelected);
    }
  };
  const transition = (
    phase: PackageActivationPhase,
    intent: PackageActivationIntent = null,
    publications = record.publications,
  ) => {
    assertCurrent();
    record = journal.transition(record, phase, intent, assertion, publications);
  };
  const matches = async (file: string, expected: PackageIntegrityFingerprint, logical: string) => {
    if (!(await packagePathEntryExists(file))) {
      return false;
    }
    const observed = await createPackageIntegrityReader().tree(file, logical);
    if (!isDeepStrictEqual(observed, expected)) {
      throw new Error(`Package publication object changed: ${file}`);
    }
    return true;
  };
  const inspect = async () => {
    const reader = createPackageIntegrityReader();
    const livePresent = await reader.exists(live);
    let selected: "previous" | "candidate" | null = null;
    if (livePresent) {
      const id = packageActivationIdentity(live, true);
      selected =
        id === descriptor.previous.identity
          ? "previous"
          : id === descriptor.candidate.identity
            ? "candidate"
            : null;
      if (!selected) {
        throw new Error("The installed package is not either recorded generation.");
      }
      await matches(
        live,
        descriptor[selected],
        selected === "previous" ? live : descriptor.originalStageRoot,
      );
    }
    const previous = await matches(root("previous"), descriptor.previous, live);
    const candidate = await matches(
      root("candidate"),
      descriptor.candidate,
      descriptor.originalStageRoot,
    );
    if ((selected === "previous") === previous || (selected === "candidate") === candidate) {
      throw new Error("Package publication generation roles are ambiguous.");
    }
    if (packageActivationIdentity(root("launchers"), true) !== descriptor.launcherRootIdentity) {
      throw new Error("Candidate launcher assets changed.");
    }
    const published = new Map(record.publications.map((entry) => [entry.name, entry.identity]));
    if (record.intent?.kind === "launcher") {
      published.set(record.intent.name, record.intent.identity);
    }
    const launcherStates = new Map<string, "previous" | "candidate">();
    for (const entry of descriptor.launchers) {
      const source = root(`launchers/${entry.name}`);
      if (
        packageActivationIdentity(source, "launcher") !== entry.candidateIdentity ||
        (await reader.launcher(source)) !== entry.candidate
      ) {
        throw new Error("Candidate launcher assets changed.");
      }
      const destination = path.join(descriptor.binDir, entry.name);
      const present = await reader.exists(destination);
      const id = present ? packageActivationIdentity(destination, "launcher") : null;
      const fingerprint = present ? await reader.launcher(destination) : null;
      if (id === entry.previousIdentity && fingerprint === entry.previous) {
        launcherStates.set(entry.name, "previous");
      } else if (id === published.get(entry.name) && fingerprint === entry.candidate) {
        launcherStates.set(entry.name, "candidate");
      } else {
        throw new Error(`Package launcher changed outside its publication intent: ${entry.name}`);
      }
    }
    return { selected, previous, candidate, launcherStates };
  };
  const verifyClosure = async () => {
    assertInventory();
    assertManagedUpdateLeaseDatabaseIdentity(descriptor.authority);
    const bytes = await fsp.readFile(root(PACKAGE_ACTIVATION_HELPER));
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.helperDigest) {
      throw new Error("Sealed package recovery helper changed.");
    }
    assertCurrent();
  };
  const preflight = async (action: "repair" | "retire") => {
    if (
      action === "repair" &&
      !["prepared", "publishing", "publication-complete"].includes(record.phase)
    ) {
      throw new Error(`Forward publication is disarmed (${record.phase}).`);
    }
    if (
      action === "retire" &&
      !["publication-complete", "rolled-back", "aborted", "retiring", "retired"].includes(
        record.phase,
      )
    ) {
      throw new Error(`Package evidence cannot be retired (${record.phase}).`);
    }
    await verifyClosure();
    if (action === "repair" || record.phase === "publication-complete") {
      await inspect();
    } else {
      const selected =
        record.intent?.kind === "remove" || record.intent?.kind === "retire"
          ? record.intent.selected
          : "previous";
      if (
        !(await matches(
          live,
          descriptor[selected],
          selected === "previous" ? live : descriptor.originalStageRoot,
        ))
      ) {
        throw new Error("Selected package is missing.");
      }
      assertSelectedLaunchers(selected);
    }
    assertCurrent();
  };
  const publish = async (resume: boolean, onDisplaced?: () => void) => {
    await verifyClosure();
    if (!["prepared", "publishing", "publication-complete"].includes(record.phase)) {
      throw new Error(`Forward publication is disarmed (${record.phase}).`);
    }
    let observed = await inspect();
    assertCurrent();
    if (resume && observed.selected === "previous" && !observed.previous) {
      if ([...observed.launcherStates.values()].some((value) => value !== "previous")) {
        throw new Error("Untouched package has changed launchers; recovery is ambiguous.");
      }
      transition("aborted");
      return status(record);
    }
    if (observed.selected === "previous") {
      transition("publishing", { kind: "displace" });
      assertCurrent();
      if (
        entryIdentity(live, true) !== descriptor.previous.identity ||
        entryIdentity(root("previous"), true) !== null
      ) {
        throw new Error("Package displacement preimage changed.");
      }
      await fsp.rename(live, root("previous"));
      onDisplaced?.();
    }
    observed = await inspect();
    assertCurrent();
    if (observed.selected === null) {
      transition("publishing", { kind: "publish" });
      await activateStagedNpmPackageRoot(root("candidate"), live, () => {
        assertCurrent();
        if (
          entryIdentity(root("candidate"), true) !== descriptor.candidate.identity ||
          entryIdentity(root("previous"), true) !== descriptor.previous.identity ||
          entryIdentity(live, true) !== null
        ) {
          throw new Error("Candidate publication preimage changed.");
        }
      });
    }
    for (const entry of descriptor.launchers) {
      observed = await inspect();
      assertCurrent();
      if (observed.launcherStates.get(entry.name) === "candidate") {
        const id = packageActivationIdentity(path.join(descriptor.binDir, entry.name), "launcher");
        if (!record.publications.some((item) => item.name === entry.name)) {
          transition("publishing", null, [
            ...record.publications,
            { name: entry.name, identity: id },
          ]);
        }
        continue;
      }
      await copyPackagePathEntry(
        root(`launchers/${entry.name}`),
        path.join(descriptor.binDir, entry.name),
        () => {
          assertCurrent();
          if (
            entryIdentity(path.join(descriptor.binDir, entry.name), "launcher") !==
              entry.previousIdentity ||
            entryIdentity(root(`launchers/${entry.name}`), "launcher") !== entry.candidateIdentity
          ) {
            throw new Error("Launcher publication preimage changed.");
          }
        },
        (staged) => {
          transition("publishing", {
            kind: "launcher",
            name: entry.name,
            identity: packageActivationIdentity(staged, "launcher"),
          });
        },
      );
      // The intent contains the new inode before rename, so loss of this
      // acknowledgement can be reconciled without accepting equal foreign bytes.
      const id = packageActivationIdentity(path.join(descriptor.binDir, entry.name), "launcher");
      transition("publishing", null, [...record.publications, { name: entry.name, identity: id }]);
    }
    observed = await inspect();
    assertCurrent();
    if (observed.selected !== "candidate") {
      throw new Error("Candidate publication is incomplete.");
    }
    transition("publication-complete");
    return status(record);
  };
  const retire = async () => {
    await verifyClosure();
    if (
      !["publication-complete", "rolled-back", "aborted", "retiring", "retired"].includes(
        record.phase,
      )
    ) {
      throw new Error(`Package evidence cannot be retired (${record.phase}).`);
    }
    const selected =
      record.intent?.kind === "remove" || record.intent?.kind === "retire"
        ? record.intent.selected
        : record.phase === "publication-complete"
          ? "candidate"
          : "previous";
    await matches(
      live,
      descriptor[selected],
      selected === "previous" ? live : descriptor.originalStageRoot,
    );
    if (!(await packagePathEntryExists(live))) {
      throw new Error("Selected package is missing.");
    }
    retirementSelected = selected;
    assertCurrent();
    if (record.phase !== "retiring" && record.phase !== "retired") {
      for (const name of ["previous", "candidate", "previous.candidate"] as const) {
        await matches(
          root(name),
          name === "previous" ? descriptor.previous : descriptor.candidate,
          name === "previous" ? live : descriptor.originalStageRoot,
        );
      }
      assertCurrent();
      const publications =
        record.phase === "aborted"
          ? descriptor.launchers.flatMap((entry) =>
              entry.previousIdentity
                ? [{ name: entry.name, identity: entry.previousIdentity }]
                : [],
            )
          : record.publications;
      transition("retiring", { kind: "retire", selected }, publications);
    }
    for (const name of [
      "previous",
      "candidate",
      "previous.candidate",
      "launchers",
      "previous-launchers",
    ] as const) {
      const target = root(name);
      if (!(await packagePathEntryExists(target))) {
        assertCurrent();
        continue;
      }
      const id = packageActivationIdentity(target, true);
      const expected =
        name === "previous"
          ? descriptor.previous.identity
          : name === "candidate" || name === "previous.candidate"
            ? descriptor.candidate.identity
            : name === "launchers"
              ? descriptor.launcherRootIdentity
              : descriptor.previousLauncherRootIdentity;
      if (id !== expected) {
        throw new Error("Retirement target identity changed.");
      }
      // Intent survives partial recursive removal; resumption still requires
      // this exact private root, never a newly created directory with equal bytes.
      transition("retiring", { kind: "remove", name, identity: id, selected });
      await removePackagePath(target, () => {
        assertCurrent();
        if (packageActivationIdentity(target, true) !== id) {
          throw new Error("Retirement target changed before removal.");
        }
      });
    }
    transition("retired", { kind: "retire", selected });
    const outcome = status(record);
    assertCurrent();
    // "retired" records removal of retained package material, not completion of
    // these final unlinks. A killed self-unlink leaves the same blocked anchor
    // for operator inspection; missing metadata never means cleanup succeeded.
    assertInventory([PACKAGE_ACTIVATION_HELPER, PACKAGE_ACTIVATION_JOURNAL]);
    if (packageActivationIdentity(root(PACKAGE_ACTIVATION_HELPER), false) !== helperIdentity) {
      throw new Error("Sealed recovery helper identity changed.");
    }
    await fsp.unlink(root(PACKAGE_ACTIVATION_HELPER));
    assertCurrent();
    assertInventory([PACKAGE_ACTIVATION_JOURNAL]);
    await fsp.unlink(root(PACKAGE_ACTIVATION_JOURNAL));
    assertion();
    if (
      packageActivationIdentity(anchor, true) !== descriptor.anchorIdentity ||
      packageActivationIdentity(live, true) !== descriptor[selected].identity
    ) {
      throw new Error("Final package recovery cleanup identity changed.");
    }
    assertInventory([]);
    await fsp.rmdir(anchor);
    return outcome;
  };
  return {
    publish,
    retire,
    preflight,
    async disarmRollback() {
      // Disarm before any restore or its compensating moves. Failure to commit
      // this fact forbids compensation; a killed rollback never becomes forward repair.
      transition("rollback-in-progress", record.intent);
      const observed = await inspect();
      assertCurrent();
      return observed.previous;
    },
    recordRestoredLauncher(name: string, staged: string) {
      if (record.phase !== "rollback-in-progress") {
        throw new Error("Launcher restoration requires durable rollback intent.");
      }
      const identity = packageActivationIdentity(staged, "launcher");
      transition("rollback-in-progress", { kind: "launcher", name, identity }, [
        ...record.publications.filter((entry) => entry.name !== name),
        { name, identity },
      ]);
    },
    restored() {
      const publications = descriptor.launchers.flatMap((entry) => {
        const identity =
          entry.previous === null
            ? null
            : (record.publications.find((published) => published.name === entry.name)?.identity ??
              entry.previousIdentity);
        if (entryIdentity(path.join(descriptor.binDir, entry.name), "launcher") !== identity) {
          throw new Error("Restored launcher does not match its original owner.");
        }
        return identity ? [{ name: entry.name, identity }] : [];
      });
      transition("rolled-back", null, publications);
    },
    status: () => status(record),
    assertCurrent,
  };
}

export async function preparePackageActivation(
  params: PackageActivationPreparation & { installTarget: ResolvedGlobalInstallTarget },
) {
  if (
    process.platform === "win32" ||
    process.versions.bun ||
    params.installTarget.manager !== "npm" ||
    params.installTarget.directNodeModulesRoot ||
    !(await fsp.lstat(params.stageRoot)).isDirectory()
  ) {
    return undefined;
  }
  const capable = await supportsPostCoreExecutor(params.stageRoot, params.options.nodeRunner);
  params.options.fence.assertCurrent();
  if (!capable) {
    // Older/respawning targets keep their shipped update path, without a
    // journal whose post-core receiver cannot prove original ownership.
    params.options.onUnavailable?.(
      "Standalone package publication repair is unavailable for this target: its preferred CLI entry does not support delegated post-core execution.",
    );
    return undefined;
  }
  const prepared = await preparePackageActivationJournal(params);
  return {
    ...prepared,
    ...createPublicationOwner(
      prepared.anchor,
      prepared.journal,
      params.options.fence.assertCurrent,
    ),
  };
}
export async function readPackageActivationStatus(
  anchor: string,
): Promise<PackageActivationStatus> {
  const record = openPackageActivationJournal(anchor).read();
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return status(record);
}
export async function runPackageActivationRecovery(
  anchor: string,
  action: "repair" | "retire",
): Promise<PackageActivationStatus> {
  const journal = openPackageActivationJournal(anchor);
  const initial = journal.read();
  // Reject malformed/foreign/disarmed recovery before acquiring a new writer.
  // Admission is still followed by the same observations under the fresh fence.
  await createPublicationOwner(anchor, journal, () => {
    assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
  }).preflight(action);
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent);
      return action === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: initial.descriptor.authority },
  );
}
