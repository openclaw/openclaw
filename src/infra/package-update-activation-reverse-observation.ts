import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import type { PackageActivationRecord } from "./package-update-activation-journal.js";
import {
  assertPackageReverseBinding,
  assertPackageReverseTarget,
  assertReverseLauncher,
} from "./package-update-activation-reverse-binding.js";
import {
  assertReverseParents,
  readPackageReverseImage,
} from "./package-update-activation-reverse-files.js";
import type { PackageActivationReverseResource } from "./package-update-activation-reverse-schema.js";

export async function observePackageReverseResources(record: PackageActivationRecord) {
  const binding = record.descriptor.reverse;
  if (!binding) {
    throw new Error("Reverse publication has no bound generation.");
  }
  assertPackageReverseBinding(binding, record.descriptor);
  const rows = [];
  for (const resource of binding.resources) {
    assertReverseParents(resource);
    const read = async (file: string) => {
      let logical: string | undefined;
      if (resource.role === "package" && fs.lstatSync(file, { throwIfNoEntry: false })) {
        const stat = fs.lstatSync(file, { bigint: true });
        const identity = `${stat.dev}:${stat.ino}`;
        logical =
          identity === record.descriptor.previous.identity
            ? record.descriptor.authority.installKey
            : record.descriptor.originalStageRoot;
      }
      return readPackageReverseImage(file, logical);
    };
    const live = await read(resource.live);
    if (!resource.move) {
      if (!isDeepStrictEqual(live, resource.after)) {
        throw new Error("Unchanged reverse resource was replaced.");
      }
      rows.push("unchanged" as const);
      continue;
    }
    const staged = await read(resource.move.staged);
    const displaced = await read(resource.move.displaced);
    const missing = { kind: "missing" };
    const equal = isDeepStrictEqual;
    const state =
      equal(live, resource.after) && equal(staged, missing) && equal(displaced, resource.before)
        ? "published"
        : equal(live, resource.before) && equal(staged, resource.after) && equal(displaced, missing)
          ? "initial"
          : equal(live, missing) &&
              equal(staged, resource.after) &&
              equal(displaced, resource.before)
            ? "displaced"
            : undefined;
    if (!state) {
      throw new Error(`Reverse publication lost exact resource custody: ${resource.live}`);
    }
    rows.push(state);
  }
  return rows;
}

export function assertPackageReverseProgress(
  record: PackageActivationRecord,
  rows: Awaited<ReturnType<typeof observePackageReverseResources>>,
) {
  if (record.intent?.kind !== "reverse" || !record.descriptor.reverse) {
    throw new Error("Reverse progress is missing.");
  }
  const { completed, effect } = record.intent;
  if (completed > rows.length || (completed === rows.length && effect !== null)) {
    throw new Error("Reverse progress is invalid.");
  }
  rows.forEach((row, index) => {
    if (row === "unchanged") {
      return;
    }
    const resource = record.descriptor.reverse!.resources[index]!;
    const allowed =
      index < completed
        ? ["published"]
        : index > completed || effect === null
          ? ["initial"]
          : effect === "displace"
            ? ["initial", "displaced", ...(resource.after.kind === "missing" ? ["published"] : [])]
            : [
                "displaced",
                "published",
                ...(resource.before.kind === "missing" ? ["initial"] : []),
              ];
    if (!allowed.includes(row)) {
      throw new Error("Reverse filesystem effect has no durable progress intent.");
    }
  });
  if (record.phase === "reverse-complete" && completed !== rows.length) {
    throw new Error("Reverse completion is not exhaustive.");
  }
}

export async function syncPackageReverseParents(resource: PackageActivationReverseResource) {
  if (!resource.move) {
    return;
  }
  for (const parent of new Set(
    [resource.live, resource.move.staged, resource.move.displaced].map((file) =>
      path.dirname(file),
    ),
  )) {
    requireDirectorySync(await syncDirectory(parent), "Reverse resource publication");
  }
}

export async function inspectPackageReverseTargetAndLaunchers(
  record: PackageActivationRecord,
  rows: Awaited<ReturnType<typeof observePackageReverseResources>>,
) {
  const binding = record.descriptor.reverse!;
  const index = binding.resources.findIndex((resource) => resource.role === "package");
  const resource = binding.resources[index]!;
  await assertPackageReverseTarget(
    binding,
    record.descriptor,
    rows[index] === "published" ? resource.live : resource.move!.staged,
  );
  for (const entry of record.descriptor.launchers) {
    const launcher = binding.resources.find(
      (value) => value.live === path.join(record.descriptor.binDir, entry.name),
    )!;
    const state = rows[binding.resources.indexOf(launcher)];
    await assertReverseLauncher(
      state === "published" || !launcher.move ? launcher.live : launcher.move.staged,
      entry.previous,
    );
  }
}
