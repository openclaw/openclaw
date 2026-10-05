import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { comparePackageDistContentInventory } from "../../scripts/lib/package-dist-inventory-contract.mts";
import {
  collectPackageDistContentInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  readPackageDistContentInventoryIfPresent,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import {
  packageActivationIdentity,
  resolvePackageActivationHelper,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import { decodePackageActivationLauncher } from "./package-update-activation-launcher.js";
import {
  createPackageIntegrityReader,
  packageLauncherDifferences,
} from "./package-update-integrity.js";

function fileObservation(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

/** Verify the installed candidate without republishing it or trusting its old tree fingerprint. */
export async function verifyPackagePublicationSettlement(
  anchor: string,
  record: PackageActivationRecord,
  assertCurrent: () => void,
) {
  const descriptor = record.descriptor;
  const live = descriptor.authority.installKey;
  const retained = `${anchor}.superseded-${descriptor.operationId}`;
  const helper = () =>
    fs.existsSync(resolvePackageActivationHelper(anchor))
      ? resolvePackageActivationHelper(anchor)
      : path.join(retained, "recovery.mjs");
  assertCurrent();
  const helperPath = helper();
  const helperBefore = fileObservation(helperPath);
  if (
    packageActivationIdentity(helperPath, false) !== descriptor.helperIdentity ||
    createHash("sha256")
      .update(await fsp.readFile(helperPath))
      .digest("hex") !== descriptor.helperDigest ||
    fileObservation(helperPath) !== helperBefore
  ) {
    throw new Error("Sealed package recovery helper changed.");
  }
  let helperVerified = helperBefore;
  const observed = new Map<string, string>();
  const remember = (file: string) => observed.set(file, fileObservation(file));
  remember(live);
  remember(path.join(live, "dist"));
  for (const relative of [
    "package.json",
    PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
    PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  ]) {
    remember(path.join(live, relative));
  }
  const expected = await readPackageDistContentInventoryIfPresent(live);
  const inventory = await readPackageDistInventoryIfPresent(live);
  if (!expected?.length || !inventory) {
    throw new Error("Package settlement requires the installed package's dist content inventory.");
  }
  const inventoried = expected.map((entry) => entry.path);
  if (
    !isDeepStrictEqual(
      inventory.toSorted(),
      [...inventoried, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH].toSorted(),
    )
  ) {
    throw new Error("Package settlement inventories disagree about the required dist paths.");
  }
  for (const relative of inventoried) {
    let file = path.join(live, relative);
    while (file !== live) {
      if (!observed.has(file)) {
        remember(file);
      }
      file = path.dirname(file);
    }
  }
  const actual = await collectPackageDistContentInventory(live, inventoried);
  const mismatches = expected
    .filter(
      (entry, index) => comparePackageDistContentInventory([entry], [actual[index]!]).length > 0,
    )
    .map((entry) => entry.path);
  if (mismatches.length) {
    throw new Error(
      `Package settlement refused: inventoried dist files changed: ${mismatches.join(", ")}.`,
    );
  }
  const buildInfo: unknown = JSON.parse(
    await fsp.readFile(path.join(live, "dist/build-info.json"), "utf8"),
  );
  if (
    !inventoried.includes("dist/build-info.json") ||
    !buildInfo ||
    typeof buildInfo !== "object" ||
    !("version" in buildInfo) ||
    buildInfo.version !== descriptor.candidate.version
  ) {
    throw new Error(
      `Package settlement requires build-info version ${descriptor.candidate.version}.`,
    );
  }
  const reader = createPackageIntegrityReader();
  for (const entry of descriptor.launchers) {
    const launcher = path.join(descriptor.binDir, entry.name);
    remember(launcher);
    if (
      packageLauncherDifferences(
        decodePackageActivationLauncher(entry.candidate),
        await reader.launcher(launcher),
        { checkMode: true },
      ).length
    ) {
      throw new Error(`Package settlement launcher changed: ${entry.name}.`);
    }
  }
  const assertUnchanged = () => {
    assertCurrent();
    if (
      packageActivationIdentity(live, true) !== descriptor.candidate.identity ||
      packageActivationIdentity(descriptor.binDir, "parent") !== descriptor.binIdentity ||
      packageActivationIdentity(helper(), false) !== descriptor.helperIdentity
    ) {
      throw new Error("Package settlement identity changed.");
    }
    const helperNow = fileObservation(helper());
    if (helperNow !== helperVerified) {
      // Archival can change ctime. Recheck the seal, including on a resumed rename.
      if (
        createHash("sha256").update(fs.readFileSync(helper())).digest("hex") !==
        descriptor.helperDigest
      ) {
        throw new Error("Sealed package recovery helper changed.");
      }
      helperVerified = helperNow;
    }
    for (const [file, before] of observed) {
      if (fileObservation(file) !== before) {
        throw new Error(`Package settlement observation changed: ${path.relative(live, file)}.`);
      }
    }
  };
  assertUnchanged();
  // Extras are diagnostics, not inventory authority: never follow links or open their contents.
  const extraInspection = await walkDirectory(path.join(live, "dist"), { symlinks: "include" });
  const inventoryPaths = new Set([...inventory, PACKAGE_DIST_INVENTORY_RELATIVE_PATH]);
  const extras = extraInspection.entries
    .filter((entry) => entry.kind !== "directory")
    .map((entry) => `dist/${entry.relativePath.replace(/\\/gu, "/")}`)
    .filter((file) => !inventoryPaths.has(file))
    .toSorted();
  const uninspected = extraInspection.failedDirs.map(
    (entry) => `dist/${entry.relativePath.replace(/\\/gu, "/")}`,
  );
  assertUnchanged();
  return {
    assertUnchanged,
    detail: `Inventoried dist content mismatches: none. Extra dist paths: ${extras.length ? extras.join(", ") : "none"}. Original per-path metadata is not retained in the sealed tree digest.${uninspected.length ? ` Extra directories whose contents could not be inspected: ${uninspected.join(", ")}.` : ""}`,
  };
}
