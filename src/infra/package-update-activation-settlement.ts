import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  comparePackageDistContentInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../scripts/lib/package-dist-inventory-contract.mts";
import { readRootJsonObjectSync } from "./json-files.js";
import { packageActivationIdentityOrAbsent as entryIdentity } from "./package-update-activation-custody.js";
import {
  packageActivationIdentity,
  type PackageActivationJournal,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  decodePackageActivationLauncher,
  matchesPackageActivationLauncher,
} from "./package-update-activation-launcher.js";
import {
  LEGACY_PACKAGE_RECOVERY_HELPER,
  privatePackageActivationIdentity,
  resolvePackageActivationHelper,
} from "./package-update-activation-paths.js";
import {
  assertPackageIntegritySettlementUnchanged,
  createPackageIntegrityReader,
  packageIntegrityMatches,
  packageStatUnchanged,
} from "./package-update-integrity.js";

// Published npm openclaw@2026.9.9 uses the same digest encoding as 2026.9.8.
// This pin selects encoding only, not the older previous-tree recovery allowances.
const PACKAGE_RECOVERY_2026_9_9_HELPER =
  "6ae5112de5a98832da6c8151c65a9cc1e42c59f210284e539e45cf4f280a427f";

/** Qualify untouched preparation or a lost publish acknowledgement, never arbitrary stale custody. */
export function inspectRemountedPackagePublication(
  anchor: string,
  record: PackageActivationRecord,
  remount: NonNullable<ReturnType<PackageActivationJournal["inspectRemount"]>>,
) {
  const d = record.descriptor;
  const live = d.authority.installKey;
  const selected: "previous" | "candidate" =
    packageActivationIdentity(live, true) === remount.currentIdentity(d.previous.identity)
      ? "previous"
      : "candidate";
  const { bind } = remount;
  const helper = resolvePackageActivationHelper(anchor);
  bind(d.helperIdentity, () => privatePackageActivationIdentity(helper, "helper"));
  bind(d.anchorIdentity, () => privatePackageActivationIdentity(anchor, "anchor"));
  bind(d.previous.identity, () =>
    packageActivationIdentity(selected === "previous" ? live : path.join(anchor, "previous"), true),
  );
  bind(d.launcherRootIdentity, () =>
    packageActivationIdentity(path.join(anchor, "launchers"), true),
  );
  if (d.previousLauncherRootIdentity) {
    bind(d.previousLauncherRootIdentity, () =>
      packageActivationIdentity(path.join(anchor, "previous-launchers"), true),
    );
  }
  if (selected === "candidate") {
    bind(d.candidate.identity, () => packageActivationIdentity(live, true));
  }
  const binIdentity = bind(d.binIdentity, () => packageActivationIdentity(d.binDir, "parent"));
  for (const entry of d.launchers) {
    const launcher = path.join(d.binDir, entry.name);
    const current = entryIdentity(launcher, "launcher");
    if (selected === "previous" && entry.previousIdentity === null && current === null) {
      continue;
    }
    // The original link may already name the candidate; equality of link contents
    // does not authorize accepting a replacement inode.
    const previous = entry.previousIdentity;
    const historical =
      (selected === "candidate"
        ? record.publications.find((published) => published.name === entry.name)?.identity
        : undefined) ??
      (previous && previous.split(":")[1] === current?.split(":")[1]
        ? previous
        : entry.candidateIdentity);
    if (
      selected === "candidate" &&
      historical === previous &&
      !matchesPackageActivationLauncher(
        entry.previous ? decodePackageActivationLauncher(entry.previous) : null,
        entry.candidate,
      )
    ) {
      throw new Error("Package settlement original launcher did not already match the candidate.");
    }
    bind(selected === "previous" && previous ? previous : historical, () =>
      packageActivationIdentity(launcher, "launcher"),
    );
  }
  const assertUnchanged = () => {
    remount.assertUnchanged();
    if (
      fs.lstatSync(path.join(anchor, selected === "previous" ? "previous" : "candidate"), {
        throwIfNoEntry: false,
      }) ||
      fs.lstatSync(d.originalStageRoot, { throwIfNoEntry: false }) ||
      createHash("sha256").update(fs.readFileSync(helper)).digest("hex") !== d.helperDigest
    ) {
      throw new Error(
        "Package settlement requires the original helper and an unambiguous installed generation.",
      );
    }
  };
  assertUnchanged();
  return { ...remount, binIdentity, assertUnchanged, selected };
}

/** Verify the installed generation without republishing it; remounts also prove the sealed tree. */
export async function verifyPackagePublicationSettlement(
  record: PackageActivationRecord,
  assertCurrent: () => void,
  remount?: ReturnType<typeof inspectRemountedPackagePublication>,
) {
  const descriptor = record.descriptor;
  const live = descriptor.authority.installKey;
  const selected = remount?.selected ?? "candidate";
  const expectedTree = descriptor[selected];
  const installedIdentity =
    remount?.currentIdentity(expectedTree.identity) ?? expectedTree.identity;
  assertCurrent();
  let assertTreeUnchanged: (() => void) | undefined;
  if (remount) {
    remount.assertUnchanged();
    const tree = await createPackageIntegrityReader().tree(
      live,
      selected === "previous" ? live : descriptor.originalStageRoot,
      undefined,
      [LEGACY_PACKAGE_RECOVERY_HELPER, PACKAGE_RECOVERY_2026_9_9_HELPER].includes(
        descriptor.helperDigest,
      ),
      remount.historicalDevices,
    );
    assertCurrent();
    remount.assertUnchanged();
    if (
      !("digest" in expectedTree) ||
      !packageIntegrityMatches({ ...expectedTree, identity: installedIdentity }, tree)
    ) {
      throw new Error(`Package settlement full ${selected} fingerprint changed.`);
    }
    assertTreeUnchanged = () => assertPackageIntegritySettlementUnchanged(tree);
  }
  const observed = new Map<string, fs.BigIntStats | undefined>();
  const reader = createPackageIntegrityReader();
  for (const entry of descriptor.launchers) {
    const launcher = path.join(descriptor.binDir, entry.name);
    const stat = fs.lstatSync(launcher, { bigint: true, throwIfNoEntry: false });
    observed.set(launcher, stat);
    if (
      !matchesPackageActivationLauncher(
        stat ? await reader.launcher(launcher) : null,
        entry[selected],
      )
    ) {
      throw new Error(`Package settlement launcher changed: ${entry.name}.`);
    }
  }
  const assertInstalledUnchanged = () => {
    assertCurrent();
    assertTreeUnchanged?.();
    if (
      packageActivationIdentity(live, true) !== installedIdentity ||
      packageActivationIdentity(descriptor.binDir, "parent") !==
        (remount?.binIdentity ?? descriptor.binIdentity)
    ) {
      throw new Error("Package settlement identity changed.");
    }
    for (const [file, before] of observed) {
      const after = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (before && after ? !packageStatUnchanged(before, after) : before !== after) {
        throw new Error(`Package settlement observation changed: ${path.relative(live, file)}.`);
      }
    }
  };
  const assertUnchanged = () => {
    remount?.assertUnchanged();
    assertInstalledUnchanged();
  };
  assertUnchanged();
  if (selected === "previous") {
    return {
      assertUnchanged,
      assertInstalledUnchanged,
      detail: "Full previous tree and unchanged launchers verified.",
    };
  }
  for (const relative of [
    "",
    "dist",
    "package.json",
    PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
    PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  ]) {
    const file = path.join(live, relative);
    observed.set(file, fs.lstatSync(file, { bigint: true }));
  }
  const {
    collectPackageDistContentInventory,
    readPackageDistContentInventoryIfPresent,
    readPackageDistInventoryIfPresent,
  } = await import("./package-dist-inventory.js");
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
        observed.set(file, fs.lstatSync(file, { bigint: true }));
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
  const buildInfo = asOptionalRecord(
    JSON.parse(await fsp.readFile(path.join(live, "dist/build-info.json"), "utf8")),
  );
  if (
    !inventoried.includes("dist/build-info.json") ||
    buildInfo?.version !== descriptor.candidate.version
  ) {
    throw new Error(
      `Package settlement requires build-info version ${descriptor.candidate.version}.`,
    );
  }
  const manifest = readRootJsonObjectSync({
    rootDir: live,
    relativePath: "package.json",
    boundaryLabel: "Package settlement",
    rejectHardlinks: false,
    maxBytes: 16 * 1024 * 1024,
  });
  if (
    !manifest.ok ||
    manifest.value.name !== "openclaw" ||
    manifest.value.version !== descriptor.candidate.version ||
    manifest.value.type !== "module"
  ) {
    throw new Error(
      `Package settlement requires package.json with name openclaw, version ${descriptor.candidate.version}, and type module.`,
    );
  }
  const contentPaths = new Set(inventoried);
  const assertTarget = (field: string, target: unknown) => {
    const file = typeof target === "string" ? path.resolve(live, target) : live;
    const relative = path.relative(live, file).split(path.sep).join("/");
    if (
      typeof target !== "string" ||
      !target ||
      target.includes("\\") ||
      (field === "exports" && !target.startsWith("./")) ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      (relative.startsWith("dist/") && !contentPaths.has(relative)) ||
      !fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(
        `Package settlement refused: package.json ${field} must resolve to a package file (inventoried within dist)${typeof target === "string" ? `: ${target}` : "."}`,
      );
    }
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(`${live}${path.sep}`)) {
      throw new Error(
        `Package settlement refused: package.json ${field} leaves the package: ${target}.`,
      );
    }
    for (const observedPath of [file, resolved]) {
      if (!observed.has(observedPath)) {
        observed.set(observedPath, fs.lstatSync(observedPath, { bigint: true }));
      }
    }
  };
  if (manifest.value.main !== undefined) {
    assertTarget("main", manifest.value.main);
  }
  if (manifest.value.bin !== undefined) {
    const bins = asOptionalRecord(manifest.value.bin);
    for (const target of bins ? Object.values(bins) : [manifest.value.bin]) {
      assertTarget("bin", target);
    }
  }
  const exportTargets = [manifest.value.exports];
  while (exportTargets.length) {
    const target = exportTargets.pop();
    if (target === undefined || target === null) {
      continue;
    }
    const conditions = asOptionalRecord(target);
    if (Array.isArray(target)) {
      exportTargets.push(...target);
    } else if (conditions) {
      exportTargets.push(...Object.values(conditions));
    } else {
      assertTarget("exports", target);
    }
  }
  assertUnchanged();
  // Only dist scopes affect inventoried modules; dependency manifests are expected.
  const extraInspection = await walkDirectory(path.join(live, "dist"), {
    symlinks: "include",
    descend: (entry) => {
      if (!observed.has(entry.path)) {
        observed.set(entry.path, fs.lstatSync(entry.path, { bigint: true }));
      }
      return true;
    },
  });
  const inventoryPaths = new Set([...inventory, PACKAGE_DIST_INVENTORY_RELATIVE_PATH]);
  const extraManifests = extraInspection.entries
    .filter((entry) => entry.name.toLowerCase() === "package.json")
    .map((entry) => `dist/${entry.relativePath.replace(/\\/gu, "/")}`)
    .filter((file) => !contentPaths.has(file));
  if (extraManifests.length || extraInspection.failedDirs.length) {
    throw new Error(
      `Package settlement refused: unverified package.json scopes: ${[
        ...extraManifests,
        ...extraInspection.failedDirs.map((entry) => `dist/${entry.relativePath} (unreadable)`),
      ].join(", ")}.`,
    );
  }
  const extras = extraInspection.entries
    .filter((entry) => entry.kind !== "directory")
    .map((entry) => `dist/${entry.relativePath.replace(/\\/gu, "/")}`)
    .filter((file) => !inventoryPaths.has(file))
    .toSorted();
  assertUnchanged();
  return {
    assertUnchanged,
    assertInstalledUnchanged,
    detail: `${remount ? "Full candidate tree, including root manifest and entry targets, verified with historical device encoding. " : "Root package.json was field-verified, not content-verified. Entry targets outside dist were checked for resolution, not content. "}Inventoried dist content mismatches: none. Extra dist paths: ${extras.length ? extras.join(", ") : "none"}. Original per-path metadata is not retained in the sealed tree digest.`,
  };
}
