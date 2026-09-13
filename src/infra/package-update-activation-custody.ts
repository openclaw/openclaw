// The journal owns both sides of each preparation rename, including lost acknowledgements.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import {
  packageActivationIdentity,
  resolvePackageActivationHelper,
  type PackageActivationJournal,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";

function identityOrAbsent(file: string, directory: boolean) {
  try {
    return packageActivationIdentity(file, directory);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function inspectPackageActivationCustody(anchor: string, record: PackageActivationRecord) {
  if (record.phase !== "preparing" || record.intent?.kind !== "prepare") {
    throw new Error("Package preparation requires its recorded transfer intent.");
  }
  const intent = record.intent;
  const descriptor = record.descriptor;
  if (
    new Set(intent.completed).size !== intent.completed.length ||
    intent.completed.some((name) => !descriptor.preparation.some((entry) => entry.name === name)) ||
    (intent.moving !== null && intent.completed.includes(intent.moving))
  ) {
    throw new Error("Package preparation custody is invalid.");
  }
  return descriptor.preparation.map((entry) => {
    const destination =
      entry.name === "anchor"
        ? anchor
        : entry.name === "helper"
          ? resolvePackageActivationHelper(anchor)
          : path.join(anchor, entry.name);
    if (
      entry.source === descriptor.authority.installKey ||
      entry.source.startsWith(`${anchor}${path.sep}`) ||
      fs.realpathSync(path.dirname(entry.source)) !== path.dirname(entry.source) ||
      packageActivationIdentity(path.dirname(entry.source), true) !== entry.sourceParentIdentity
    ) {
      throw new Error("Package preparation source parent changed.");
    }
    const source = identityOrAbsent(entry.source, entry.name !== "helper");
    const target = identityOrAbsent(destination, entry.name !== "helper");
    // First use publishes the complete control directory in one rename; its
    // helper is already resident, unlike every later journal-owned transfer.
    const resident = entry.name === "helper" && entry.source === destination;
    if (
      resident &&
      (entry.sourceParentIdentity !== descriptor.journalParentIdentity ||
        !intent.completed.includes("helper") ||
        intent.moving === "helper" ||
        source !== entry.identity)
    ) {
      throw new Error("Resident package helper custody is invalid.");
    }
    const moved = resident || (source === null && target === entry.identity);
    if (moved) {
      if (!intent.completed.includes(entry.name) && intent.moving !== entry.name) {
        throw new Error("Package preparation transfer has no recorded intent.");
      }
    } else if (
      source !== entry.identity ||
      target !== null ||
      intent.completed.includes(entry.name)
    ) {
      throw new Error("Package preparation object custody is ambiguous or replaced.");
    }
    return {
      name: entry.name,
      source: entry.source,
      identity: entry.identity,
      sourceParentIdentity: entry.sourceParentIdentity,
      destination,
      moved,
    };
  });
}

export async function completePackageActivationCustody(
  anchor: string,
  journal: PackageActivationJournal,
  assertCurrent: () => void,
  onHelperReady?: () => void,
) {
  let record = journal.read();
  if (record.phase !== "preparing") {
    return;
  }
  const entries = inspectPackageActivationCustody(anchor, record);
  if (record.intent?.kind === "prepare" && record.intent.completed.includes("helper")) {
    assertCurrent();
    journal.assertCurrent(record);
    onHelperReady?.();
  }
  for (const entry of entries) {
    if (record.intent?.kind !== "prepare") {
      throw new Error("Preparation intent changed.");
    }
    if (record.intent.completed.includes(entry.name)) {
      continue;
    }
    if (!entry.moved) {
      record = journal.transition(
        record,
        "preparing",
        {
          kind: "prepare",
          completed: record.intent.completed,
          moving: entry.name,
        },
        assertCurrent,
      );
      assertCurrent();
      journal.assertCurrent(record);
      const current = inspectPackageActivationCustody(anchor, record).find(
        (item) => item.name === entry.name,
      );
      if (!current || current.moved) {
        throw new Error("Preparation preimage changed before rename.");
      }
      await fsp.rename(entry.source, entry.destination);
    }
    assertCurrent();
    journal.assertCurrent(record);
    const moved = inspectPackageActivationCustody(anchor, record).find(
      (item) => item.name === entry.name,
    );
    if (!moved?.moved || record.intent?.kind !== "prepare") {
      throw new Error("Preparation transfer was not observed.");
    }
    record = journal.transition(
      record,
      "preparing",
      {
        kind: "prepare",
        completed: [...record.intent.completed, entry.name],
        moving: null,
      },
      assertCurrent,
    );
    if (entry.name === "helper") {
      onHelperReady?.();
    }
  }
  journal.transition(record, "prepared", null, assertCurrent);
}
