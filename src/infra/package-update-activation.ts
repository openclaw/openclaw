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
  completePackageActivationCustody,
  inspectPackageActivationCustody,
} from "./package-update-activation-custody.js";
import {
  openPackageActivationJournal,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  packageActivationIdentity,
  resolvePackageActivationJournalPath,
  resolvePackageActivationHelper,
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
  type PackageActivationIntent,
  type PackageActivationJournal,
  type PackageActivationPhase,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  preparePackageActivationJournal,
  packageActivationRecoveryCommand,
  type PackageActivationPreparation,
} from "./package-update-activation-prepare.js";
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
  phase: PackageActivationPhase | "complete";
  operationId: string;
  installKey: string;
};
const status = (record: PackageActivationRecord): PackageActivationStatus => ({
  phase: isPackageActivationComplete(
    resolvePackageActivationAnchor(record.descriptor.authority.installKey),
    record,
  )
    ? "complete"
    : record.phase,
  operationId: record.descriptor.operationId,
  installKey: record.descriptor.authority.installKey,
});

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  assertPackageActivationLayout(anchor);
  const journalPath = resolvePackageActivationJournalPath(anchor);
  if (!fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
    if (
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(resolvePackageActivationControl(anchor), { throwIfNoEntry: false })
    ) {
      throw new Error(
        `Incomplete or legacy recovery artifacts require their original owner: ${anchor}. The next mutable update is blocked.`,
      );
    }
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  if (isPackageActivationComplete(anchor, record)) {
    return undefined;
  }
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
  const operationId = openPackageActivationJournal(anchor).read().descriptor.operationId;
  throw new Error(
    `Package publication recovery is pending. With an external Node, run ${packageActivationRecoveryCommand("node", anchor, operationId)} status, then repair or retire; keep other package managers stopped.`,
  );
}

function createPublicationOwner(
  anchor: string,
  journal: PackageActivationJournal,
  assertion: () => void,
  initial = journal.read(),
) {
  let record = initial;
  const descriptor = record.descriptor;
  let retirementSelected: "previous" | "candidate" | undefined;
  const live = descriptor.authority.installKey;
  const root = (name: string) => path.join(anchor, name);
  const helperIdentity = descriptor.helperIdentity;
  const custodyPath = (name: "anchor" | "helper") => {
    if (record.phase !== "preparing") {
      return name === "anchor" ? anchor : resolvePackageActivationHelper(anchor);
    }
    const entry = inspectPackageActivationCustody(anchor, record).find(
      (item) => item.name === name,
    );
    if (!entry) {
      throw new Error("Package bootstrap custody is missing.");
    }
    return entry.moved ? entry.destination : entry.source;
  };
  const helper = () => custodyPath("helper");
  const artifactNames = [
    "previous",
    "candidate",
    "previous.candidate",
    "launchers",
    "previous-launchers",
  ];
  const assertInventory = (allowed = artifactNames) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(custodyPath("anchor"));
    } catch (error) {
      if (
        hasErrnoCode(error, "ENOENT") &&
        (record.phase === "anchor-retired" || record.intent?.kind === "remove-anchor")
      ) {
        return;
      }
      throw error;
    }
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
    const currentAnchor = entryIdentity(custodyPath("anchor"), true);
    if (
      currentAnchor !== descriptor.anchorIdentity &&
      !(
        currentAnchor === null &&
        (record.phase === "anchor-retired" || record.intent?.kind === "remove-anchor")
      )
    ) {
      throw new Error("Package recovery anchor identity changed.");
    }
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
    if (packageActivationIdentity(helper(), false) !== helperIdentity) {
      throw new Error("Sealed package recovery helper identity changed.");
    }
    const bytes = await fsp.readFile(helper());
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.helperDigest) {
      throw new Error("Sealed package recovery helper changed.");
    }
    assertCurrent();
  };
  const preflight = async (action: "repair" | "retire") => {
    if (
      action === "repair" &&
      !["preparing", "prepared", "publishing", "publication-complete"].includes(record.phase)
    ) {
      throw new Error(`Forward publication is disarmed (${record.phase}).`);
    }
    if (
      action === "retire" &&
      !["publication-complete", "rolled-back", "aborted", "retiring", "anchor-retired"].includes(
        record.phase,
      )
    ) {
      throw new Error(`Package evidence cannot be retired (${record.phase}).`);
    }
    await verifyClosure();
    if (record.phase === "preparing") {
      inspectPackageActivationCustody(anchor, record);
    } else if (action === "repair" || record.phase === "publication-complete") {
      await inspect();
    } else {
      const selected =
        record.intent?.kind === "remove" ||
        record.intent?.kind === "retire" ||
        record.intent?.kind === "remove-anchor" ||
        record.intent?.kind === "unlink-helper"
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
    if (!["preparing", "prepared", "publishing", "publication-complete"].includes(record.phase)) {
      throw new Error(`Forward publication is disarmed (${record.phase}).`);
    }
    if (record.phase === "preparing") {
      await completePackageActivationCustody(anchor, journal, assertion);
      record = journal.read();
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
      !["publication-complete", "rolled-back", "aborted", "retiring", "anchor-retired"].includes(
        record.phase,
      )
    ) {
      throw new Error(`Package evidence cannot be retired (${record.phase}).`);
    }
    const selected =
      record.intent?.kind === "remove" ||
      record.intent?.kind === "retire" ||
      record.intent?.kind === "remove-anchor" ||
      record.intent?.kind === "unlink-helper"
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
    if (!["retiring", "anchor-retired"].includes(record.phase)) {
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
    if (record.phase !== "anchor-retired") {
      if (record.intent?.kind !== "remove-anchor") {
        transition("retiring", {
          kind: "remove-anchor",
          identity: descriptor.anchorIdentity,
          selected,
        });
      }
      assertCurrent();
      assertInventory([]);
      const current = entryIdentity(anchor, true);
      if (current !== null) {
        if (current !== descriptor.anchorIdentity) {
          throw new Error("Final anchor identity changed.");
        }
        await fsp.rmdir(anchor);
      }
      // A lost rmdir acknowledgement is reconciled only against the recorded
      // exact-anchor intent. Positive completion precedes the final helper intent.
      assertCurrent();
      if (entryIdentity(anchor, true) !== null) {
        throw new Error("Package anchor was not retired.");
      }
      transition("anchor-retired", { kind: "retire", selected });
    }
    assertCurrent();
    if (
      entryIdentity(anchor, true) !== null ||
      packageActivationIdentity(helper(), false) !== helperIdentity
    ) {
      throw new Error("Final package recovery cleanup identity changed.");
    }
    transition("anchor-retired", { kind: "unlink-helper", identity: helperIdentity, selected });
    assertCurrent();
    if (packageActivationIdentity(helper(), false) !== helperIdentity) {
      throw new Error("Final helper identity changed.");
    }
    await fsp.unlink(helper());
    // The bounded last receipt remains. A later reader can recognize this exact
    // intended absence even when this acknowledgement is lost. No trailing write.
    return status(record);
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
export function readPackageActivationReceipt(
  installKey: string,
): PackageActivationStatus | undefined {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    readPackageActivationContinuation(installKey);
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return status(record);
}
export async function readPackageActivationStatus(
  anchor: string,
  operationId: string,
): Promise<PackageActivationStatus> {
  const record = openPackageActivationJournal(anchor).read();
  assertOperation(record, operationId);
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return status(record);
}
export async function runPackageActivationRecovery(
  anchor: string,
  action: "repair" | "retire",
  operationId: string,
): Promise<PackageActivationStatus> {
  const journal = openPackageActivationJournal(anchor);
  const initial = journal.read();
  assertOperation(initial, operationId);
  if (isPackageActivationComplete(anchor, initial)) {
    assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
    return status(initial);
  }
  // Reject malformed/foreign/disarmed recovery before acquiring a new writer.
  // Admission is still followed by the same observations under the fresh fence.
  await createPublicationOwner(
    anchor,
    journal,
    () => {
      assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
    },
    initial,
  ).preflight(action);
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent, initial);
      return action === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: initial.descriptor.authority },
  );
}

function assertOperation(record: PackageActivationRecord, operationId: string): void {
  if (record.descriptor.operationId !== operationId) {
    throw new Error("Package recovery command belongs to a different operation.");
  }
}
