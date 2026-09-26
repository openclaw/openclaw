import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { hasErrnoCode } from "./errors.js";
import {
  completePackageActivationCustody,
  packageActivationIdentityOrAbsent as entryIdentity,
  inspectPackageActivationCustody,
} from "./package-update-activation-custody.js";
import {
  packageActivationIdentity,
  resolvePackageActivationHelper,
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
  type PackageActivationIntent,
  type PackageActivationJournal,
  type PackageActivationPhase,
  type PackageActivationRecord,
  encodePackageActivationLauncher,
} from "./package-update-activation-journal.js";
import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import { createPackageActivationReverseOwner } from "./package-update-activation-reverse.js";
import type { PackageActivationStatus } from "./package-update-activation-status.js";
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
import { capturePackageReverseExecutor } from "./package-update-reverse-authority.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-activation-status.js";
export const packageActivationStatus = (
  record: PackageActivationRecord,
): PackageActivationStatus => ({
  phase: isPackageActivationComplete(
    resolvePackageActivationAnchor(record.descriptor.authority.installKey),
    record,
  )
    ? "complete"
    : record.phase,
  operationId: record.descriptor.operationId,
  installKey: record.descriptor.authority.installKey,
});

export function createPublicationOwner(
  anchor: string,
  journal: PackageActivationJournal,
  assertion: () => void,
  initial = journal.read(),
  assertJournalCurrent: (expected: PackageActivationRecord) => void = journal.assertCurrent.bind(
    journal,
  ),
  fence?: UpdateRecoveryFence,
  resuming = false,
  executor?: ReturnType<typeof capturePackageReverseExecutor>,
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
  const verifySelectedLaunchers = async (selected: "previous" | "candidate") => {
    const reader = createPackageIntegrityReader();
    assertSelectedLaunchers(selected);
    for (const entry of descriptor.launchers) {
      const destination = path.join(descriptor.binDir, entry.name);
      const fingerprint = (await reader.exists(destination))
        ? encodePackageActivationLauncher(await reader.launcher(destination))
        : null;
      if (fingerprint !== entry[selected]) {
        throw new Error("Selected package launcher fingerprint changed.");
      }
    }
    assertSelectedLaunchers(selected);
  };
  const assertCurrent = (assertExecutor = assertion) => {
    assertExecutor();
    assertJournalCurrent(record);
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
    reverse?: PackageActivationReverseBinding,
    assertExecutor = assertion,
  ) => {
    assertCurrent(assertExecutor);
    record = journal.transition(record, phase, intent, assertExecutor, publications, reverse);
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
        encodePackageActivationLauncher(await reader.launcher(source)) !== entry.candidate
      ) {
        throw new Error("Candidate launcher assets changed.");
      }
      const destination = path.join(descriptor.binDir, entry.name);
      const present = await reader.exists(destination);
      const id = present ? packageActivationIdentity(destination, "launcher") : null;
      const fingerprint = present
        ? encodePackageActivationLauncher(await reader.launcher(destination))
        : null;
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
  const verifyClosure = async (assertExecutor = assertion) => {
    assertInventory();
    assertManagedUpdateLeaseDatabaseIdentity(descriptor.authority);
    if (packageActivationIdentity(helper(), false) !== helperIdentity) {
      throw new Error("Sealed package recovery helper identity changed.");
    }
    const bytes = await fsp.readFile(helper());
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.helperDigest) {
      throw new Error("Sealed package recovery helper changed.");
    }
    assertCurrent(assertExecutor);
  };
  const preflight = async (action: "repair" | "retire", assertExecutor = assertion) => {
    if (action === "retire" && record.descriptor.reverse && record.phase !== "rolled-back") {
      throw new Error(
        "Reverse-bound evidence requires verified successor admission before retirement.",
      );
    }
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
    await verifyClosure(assertExecutor);
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
      await verifySelectedLaunchers(selected);
    }
    assertCurrent(assertExecutor);
  };
  const publish = async (resume: boolean, onDisplaced?: () => void | Promise<void>) => {
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
      return packageActivationStatus(record);
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
      await onDisplaced?.();
      assertCurrent();
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
        const destination = path.join(descriptor.binDir, entry.name);
        const id = packageActivationIdentity(destination, "launcher");
        // The rename may have succeeded before its directory sync/ack failed.
        requireDirectorySync(await syncDirectory(descriptor.binDir), "Recovered package launcher");
        assertCurrent();
        if (packageActivationIdentity(destination, "launcher") !== id) {
          throw new Error("Recovered launcher changed during persistence.");
        }
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
            entryIdentity(root(`launchers/${entry.name}`), "launcher") !== entry.candidateIdentity
          ) {
            throw new Error("Launcher publication preimage changed.");
          }
        },
        (staged) => {
          // The destination preimage is required only before publication. The
          // continuing authority also runs after rename, against the new inode.
          assertCurrent();
          if (
            entryIdentity(path.join(descriptor.binDir, entry.name), "launcher") !==
            entry.previousIdentity
          ) {
            throw new Error("Launcher publication preimage changed.");
          }
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
    return packageActivationStatus(record);
  };
  const retire = async () => {
    await verifyClosure();
    if (record.descriptor.reverse && record.phase !== "rolled-back") {
      throw new Error(
        "Reverse-bound evidence requires verified successor admission before retirement.",
      );
    }
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
    await verifySelectedLaunchers(selected);
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
        // The removal owner also checks authority after its final unlink. That
        // intended absence is safe; a replacement directory never is.
        const current = entryIdentity(target, true);
        if (current !== null && current !== id) {
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
      // Persist removal even when resuming its lost acknowledgement. The journal
      // must not outlive the directory entry change and skip a resurrected anchor.
      assertCurrent();
      requireDirectorySync(await syncDirectory(path.dirname(anchor)), "Package anchor retirement");
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
    return packageActivationStatus(record);
  };
  const assertLegacyRollback = () => {
    if (executor && !resuming) {
      // A candidate selected by the native executor cannot be replaced by
      // ordinary rename-based rollback. Preserve its native reverse lifetime.
      throw new Error("Selected package rollback requires native reverse publication.");
    }
  };
  return {
    ...createPackageActivationReverseOwner({
      journal,
      current: () => record,
      transition,
      prepareReverse: (preparation, assertExecutor) => {
        assertCurrent(assertExecutor);
        record = journal.prepareReverse(record, preparation, () => assertCurrent(assertExecutor));
      },
      sealReverse: (binding, assertExecutor) => {
        assertCurrent(assertExecutor);
        record = journal.sealReverse(record, binding, () => assertCurrent(assertExecutor));
      },
      assertCurrent,
      verifyClosure,
      verifyForward: (assertExecutor) => preflight("repair", assertExecutor),
      executor:
        executor ??
        (resuming && fence && descriptor.originalRunId
          ? capturePackageReverseExecutor(fence, descriptor.originalRunId, true)
          : undefined),
      fence,
      resuming,
    }),
    publish,
    retire,
    preflight: (action: "repair" | "retire") => preflight(action),
    assertLegacyRollback,
    async disarmRollback() {
      assertCurrent();
      assertLegacyRollback();
      if (record.descriptor.reverse) {
        throw new Error("Bound reverse publication cannot use legacy rollback.");
      }
      const observed = await inspect();
      assertCurrent();
      if (
        observed.selected === "previous" &&
        !observed.previous &&
        [...observed.launcherStates.values()].every((value) => value === "previous")
      ) {
        transition("aborted");
        return false;
      }
      // Disarm before any restore or its compensating moves. Failure to commit
      // this fact forbids compensation; a killed rollback never becomes forward repair.
      transition("rollback-in-progress", record.intent);
      const disarmed = await inspect();
      assertCurrent();
      return disarmed.previous;
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
      if (record.descriptor.reverse) {
        throw new Error("Bound reverse publication requires exhaustive settlement.");
      }
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
    synchronize() {
      assertion();
      const current = journal.read();
      if (!isDeepStrictEqual(current.descriptor, record.descriptor)) {
        throw new Error("Forward publication changed its retained transaction descriptor.");
      }
      journal.assertCurrent(current);
      record = current;
      assertCurrent();
    },
    status: () => packageActivationStatus(record),
    assertCurrent: () => assertCurrent(),
  };
}
