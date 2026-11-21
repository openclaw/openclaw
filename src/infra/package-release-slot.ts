import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { syncDirectoryIfSupported } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import {
  packageReleaseGlobalRoot,
  packageReleasePrefixOfRoot,
  PACKAGE_RELEASES_DIR,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import { readPackageVersionIfPresent } from "./package-update-integrity.js";
import { exchangePaths, type PathExchangeResult } from "./path-exchange.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import {
  resolveExpectedInstalledVersionFromSpec,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const TEMPORARY_LINK_PREFIX = ".openclaw.release-link-";

export type PackageReleaseIdentity = {
  path: string;
  /** `<dev>:<ino>` of the release's package directory. */
  identity: string;
  version: string | null;
  build: string | null;
};

/** The package link (or a plain directory to adopt) on an OpenClaw-owned prefix. */
export type PackageReleaseTarget = { slot: string; prefix: string };

/** The update run's record of a switch: advice for the next run, always rechecked. */
export type PackageReleaseRecord = {
  slot: string;
  from: PackageReleaseIdentity;
  to: PackageReleaseIdentity;
  adoption?: true;
};

export type PackageReleaseSlotCapture =
  | { kind: "link"; identity: string; target: string; release: PackageReleaseIdentity }
  | { kind: "directory"; identity: string; release: PackageReleaseIdentity };

const statIdentity = (stat: fsSync.BigIntStats) => `${stat.dev}:${stat.ino}`;

/** Release identity comes from the directory's content, never from its name. */
export async function readPackageReleaseIdentity(root: string): Promise<PackageReleaseIdentity> {
  const real = await fs.realpath(root);
  const stat = await fs.lstat(real, { bigint: true });
  if (!stat.isDirectory()) {
    throw new Error(`Package release ${real} is not a directory`);
  }
  const [version, build] = await Promise.all([
    readPackageVersionIfPresent(real),
    readBuiltGatewayBuildId(real),
  ]);
  return { path: real, identity: statIdentity(stat), version, build };
}

export async function capturePackageReleaseSlot(slot: string): Promise<PackageReleaseSlotCapture> {
  const entry = await fs.lstat(slot, { bigint: true });
  const release = await readPackageReleaseIdentity(slot);
  return entry.isSymbolicLink()
    ? { kind: "link", identity: statIdentity(entry), target: await fs.readlink(slot), release }
    : { kind: "directory", identity: statIdentity(entry), release };
}

/** Throws unless the release still has the identity recorded for it. */
export async function assertPackageReleaseIdentity(expected: PackageReleaseIdentity) {
  const actual = await readPackageReleaseIdentity(expected.path).catch(() => null);
  if (
    !actual ||
    actual.path !== expected.path ||
    actual.identity !== expected.identity ||
    actual.version !== expected.version ||
    actual.build !== expected.build
  ) {
    throw new Error(
      `Package release ${expected.path} changed since it was recorded; it is not a rollback target.`,
    );
  }
}

/** Relative text keeps the link valid when the whole prefix moves. */
export function packageReleaseLinkTarget(slot: string, releaseRoot: string): string {
  return path.relative(path.dirname(slot), releaseRoot);
}

/** Allocate the private npm prefix that becomes a release once the link names it. */
export async function createPackageReleasePrefix(prefix: string, label: string): Promise<string> {
  const releasesDir = path.join(prefix, PACKAGE_RELEASES_DIR);
  await fs.mkdir(releasesDir, { recursive: true });
  const safeLabel = label.replace(/[^\w.+-]/gu, "-").replace(/^\.+/u, "") || "release";
  const releasePrefix = path.join(
    releasesDir,
    `${safeLabel}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
  );
  await fs.mkdir(releasePrefix);
  return releasePrefix;
}

/**
 * Allocate this update's release stage, or say why the release layout cannot be
 * used for it. Adoption renames the package directory into `releases/`, so the
 * releases must be on the package path's filesystem.
 */
export async function createPackageReleaseStage(
  release: PackageReleaseTarget & { label: string },
  globalRoot: string,
): Promise<{ prefix: string } | { unavailable: string }> {
  let prefix: string | undefined;
  try {
    prefix = await createPackageReleasePrefix(release.prefix, release.label);
    const [stage, slotParent] = await Promise.all([fs.stat(prefix), fs.stat(globalRoot)]);
    if (stage.dev === slotParent.dev) {
      return { prefix };
    }
    await fs.rm(prefix, { recursive: true, force: true });
    return {
      unavailable: `${path.join(release.prefix, PACKAGE_RELEASES_DIR)} is on another filesystem than ${globalRoot}`,
    };
  } catch (error) {
    if (prefix) {
      await fs.rm(prefix, { recursive: true, force: true }).catch(() => {});
    }
    return {
      unavailable: `release directories could not be created in ${path.join(release.prefix, PACKAGE_RELEASES_DIR)}: ${formatErrorMessage(error)}`,
    };
  }
}

function assertSameLink(
  slot: string,
  entry: fsSync.BigIntStats | null,
  target: string | null,
  expected: { identity: string; target: string },
) {
  if (
    !entry?.isSymbolicLink() ||
    statIdentity(entry) !== expected.identity ||
    target !== expected.target
  ) {
    throw new Error(`Package link ${slot} changed since it was captured; it was left unchanged.`);
  }
}

/** Remove leftover temporary links; only symbolic links are removed, never recursively. */
export async function sweepPackageReleaseTemporaryLinks(globalRoot: string): Promise<string[]> {
  const names = (await fs.readdir(globalRoot).catch(ignoreMissingPath)) ?? [];
  const removed: string[] = [];
  for (const name of names.filter((entry) => entry.startsWith(TEMPORARY_LINK_PREFIX))) {
    const entry = path.join(globalRoot, name);
    const stat = await fs.lstat(entry).catch(ignoreMissingPath);
    if (stat?.isSymbolicLink()) {
      await fs.unlink(entry).catch(ignoreMissingPath);
      removed.push(entry);
    }
  }
  return removed;
}

async function createTemporaryLink(globalRoot: string, target: string) {
  const temporary = path.join(
    globalRoot,
    `${TEMPORARY_LINK_PREFIX}${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  await fs.symlink(target, temporary);
  const identity = statIdentity(await fs.lstat(temporary, { bigint: true }));
  await syncDirectoryIfSupported(globalRoot);
  return { temporary, identity };
}

/**
 * Point the link at another release with one rename. The rename replaces only
 * the captured link; the caller holds the slot lease and passes its check.
 */
export async function switchPackageReleaseLink(params: {
  slot: string;
  expected: { identity: string; target: string };
  target: string;
  assertCurrent: () => void;
  /** Rechecked immediately before the rename. */
  assertCandidate?: () => Promise<void>;
}): Promise<{ identity: string; target: string }> {
  const globalRoot = path.dirname(params.slot);
  const current = await fs.lstat(params.slot, { bigint: true });
  assertSameLink(params.slot, current, await fs.readlink(params.slot), params.expected);
  await sweepPackageReleaseTemporaryLinks(globalRoot);
  const { temporary, identity } = await createTemporaryLink(globalRoot, params.target);
  try {
    params.assertCurrent();
    await params.assertCandidate?.();
    const entry = await fs.lstat(params.slot, { bigint: true }).catch(ignoreMissingPath);
    const target = entry ? await fs.readlink(params.slot).catch(() => null) : null;
    assertSameLink(params.slot, entry ?? null, target, params.expected);
    params.assertCurrent();
  } catch (error) {
    await fs.unlink(temporary).catch(ignoreMissingPath);
    throw error;
  }
  await fs.rename(temporary, params.slot);
  const published = await fs.lstat(params.slot, { bigint: true });
  if (statIdentity(published) !== identity) {
    throw new Error(`Package link ${params.slot} was replaced during the release switch.`);
  }
  await syncDirectoryIfSupported(globalRoot);
  // Retention counts a release's age from when the link stopped naming it.
  const deselectedPrefix = packageReleasePrefixOfRoot(
    path.resolve(globalRoot, params.expected.target),
  );
  if (deselectedPrefix) {
    const now = new Date();
    await fs.utimes(deselectedPrefix, now, now).catch(() => {});
  }
  return { identity, target: params.target };
}

/**
 * Turn a plain package directory into a release behind a link that still names
 * it. One atomic exchange puts the link on the package path and the directory in
 * its release, so the package path always resolves. Where no exchange is
 * available, two renames do it instead and the package path is missing between
 * them; a process killed there leaves `.openclaw.release-link-*` naming the
 * unchanged previous release, and renaming that link onto the package path
 * restores the installation.
 */
export async function adoptPackageReleaseSlot(params: {
  slot: string;
  /** An empty prefix from `createPackageReleasePrefix`; removed if adoption is refused. */
  releasePrefix: string;
  expected: { identity: string };
  assertCurrent: () => void;
}): Promise<{
  identity: string;
  target: string;
  releaseRoot: string;
  /** `unavailable` says why the two renames ran instead. */
  exchange: PathExchangeResult;
}> {
  const globalRoot = path.dirname(params.slot);
  const releaseGlobalRoot = packageReleaseGlobalRoot(params.releasePrefix);
  const releaseRoot = path.join(releaseGlobalRoot, path.basename(params.slot));
  const target = packageReleaseLinkTarget(params.slot, releaseRoot);
  const assertCaptured = async () => {
    params.assertCurrent();
    const current = await fs.lstat(params.slot, { bigint: true });
    if (!current.isDirectory() || statIdentity(current) !== params.expected.identity) {
      throw new Error(`Package directory ${params.slot} changed since it was captured.`);
    }
  };
  let temporary: string | undefined;
  try {
    await fs.mkdir(releaseGlobalRoot, { recursive: true });
    await sweepPackageReleaseTemporaryLinks(globalRoot);
    // The link waits where the directory will live. Its text is relative to the
    // package path's directory, so it names nothing until the exchange moves it.
    await fs.symlink(target, releaseRoot);
    const waiting = statIdentity(await fs.lstat(releaseRoot, { bigint: true }));
    await syncDirectoryIfSupported(releaseGlobalRoot);
    await assertCaptured();
    const exchange = await exchangePaths(params.slot, releaseRoot);
    let identity = waiting;
    if (exchange.status === "unavailable") {
      await fs.unlink(releaseRoot).catch(ignoreMissingPath);
      const created = await createTemporaryLink(globalRoot, target);
      temporary = created.temporary;
      identity = created.identity;
      await assertCaptured();
      await fs.rename(params.slot, releaseRoot);
      try {
        await fs.rename(temporary, params.slot);
      } catch (error) {
        // Put the directory back. If that fails too, keep the temporary link: it
        // names the moved directory and is the documented way back.
        const restored = await fs.rename(releaseRoot, params.slot).then(
          () => true,
          () => false,
        );
        if (!restored) {
          temporary = undefined;
        }
        throw error;
      }
    }
    await syncDirectoryIfSupported(releaseGlobalRoot);
    await syncDirectoryIfSupported(globalRoot);
    return { identity, target, releaseRoot, exchange };
  } catch (error) {
    if (temporary) {
      await fs.unlink(temporary).catch(ignoreMissingPath);
    }
    // Never recursive: the waiting link and the empty directories go, a moved package stays.
    const waits = await fs.lstat(releaseRoot).then(
      (entry) => entry.isSymbolicLink(),
      () => false,
    );
    if (waits) {
      await fs.unlink(releaseRoot).catch(() => {});
    }
    for (const empty of [
      releaseGlobalRoot,
      path.dirname(releaseGlobalRoot),
      params.releasePrefix,
    ]) {
      await fs.rmdir(empty).catch(() => {});
    }
    throw error;
  }
}

/**
 * The first launcher the update manages whose candidate link is not the link the
 * prefix already has. A release switch changes nothing outside the release, so a
 * difference needs the swap, which replaces those launchers.
 */
export async function findPackageReleaseLauncherDifference(
  /** The launchers the update manages, from `resolvePackageUpdateLauncherNames`. */
  names: readonly string[],
  releaseBinDir: string,
  binDir: string,
): Promise<string | null> {
  for (const name of names) {
    const [candidate, installed] = await Promise.all([
      fs.readlink(path.join(releaseBinDir, name)).catch(() => null),
      fs.readlink(path.join(binDir, name)).catch(() => null),
    ]);
    if (candidate === null || candidate !== installed) {
      return `launcher ${name} in the candidate (${candidate ?? "not a link"}) differs from ${path.join(binDir, name)} (${installed ?? "missing or not a link"})`;
    }
  }
  return null;
}

/** The prefixes `install-cli.sh` and the durable service copy own. */
export function isOpenClawOwnedPackagePrefix(prefix: string, stateDir: string): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    const real = fsSync.realpathSync.native(prefix);
    const durable = fsSync.realpathSync.native(path.join(stateDir, "npm"));
    if (real === durable) {
      return true;
    }
  } catch {
    // A missing durable prefix cannot own this one.
  }
  const tools = path.dirname(prefix);
  return (
    /^node-v\d+\.\d+\.\d+/u.test(path.basename(prefix)) &&
    path.basename(tools) === "tools" &&
    fsSync.lstatSync(path.join(tools, "node"), { throwIfNoEntry: false })?.isSymbolicLink() === true
  );
}

/**
 * The release target for an update of this package path: its release link, or a
 * plain directory to adopt on a prefix OpenClaw owns. Anything else keeps the swap.
 */
export function resolvePackageReleaseTarget(
  packageRoot: string | null | undefined,
  env: NodeJS.ProcessEnv,
): PackageReleaseTarget | null {
  if (!packageRoot || process.platform === "win32") {
    return null;
  }
  const linked = readPackageReleaseSlotSync(packageRoot);
  if (linked) {
    return { slot: linked.slot, prefix: linked.prefix };
  }
  try {
    if (!fsSync.lstatSync(packageRoot).isDirectory()) {
      return null;
    }
    const slot = path.join(
      fsSync.realpathSync.native(path.dirname(packageRoot)),
      path.basename(packageRoot),
    );
    const lib = path.dirname(path.dirname(slot));
    if (path.basename(path.dirname(slot)) !== "node_modules" || path.basename(lib) !== "lib") {
      return null;
    }
    const prefix = path.dirname(lib);
    return isOpenClawOwnedPackagePrefix(prefix, resolveStateDir(env)) ? { slot, prefix } : null;
  } catch {
    return null;
  }
}

/**
 * The release stage for `openclaw update`, labelled with the version it expects
 * to install. npm only: pnpm and Bun stage their own projects, and a Git source
 * exposure keeps its link to the checkout.
 */
export function resolvePackageReleaseStage(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  installSpec: string;
  env?: NodeJS.ProcessEnv;
  expectedGitCheckout?: unknown;
  activateGitRoot?: string;
}): (PackageReleaseTarget & { label: string }) | undefined {
  const target =
    params.installTarget.manager !== "npm" ||
    params.installTarget.directNodeModulesRoot === true ||
    params.expectedGitCheckout ||
    params.activateGitRoot
      ? null
      : resolvePackageReleaseTarget(params.installTarget.packageRoot, params.env ?? process.env);
  return target
    ? {
        ...target,
        label:
          resolveExpectedInstalledVersionFromSpec(params.packageName, params.installSpec) ??
          "release",
      }
    : undefined;
}
