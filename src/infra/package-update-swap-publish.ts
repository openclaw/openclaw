import fs from "node:fs/promises";
import { formatErrorMessage } from "./errors.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  activateStagedNpmPackageRoot,
  backupNpmPackageRoot,
  movePackageRoot,
} from "./package-update-filesystem.js";
import type { createNpmPackageRootLinkLifecycle } from "./package-update-npm-root.js";
import { exchangePaths, supportsPathExchange, type PathExchangeResult } from "./path-exchange.js";

/** Whether one atomic exchange can publish this stage: only a directory can take the backup name. */
export async function canExchangeStagedPackageRoot(stagedRoot: string): Promise<boolean> {
  return (
    supportsPathExchange() &&
    (await fs.lstat(stagedRoot).then(
      (stage) => stage.isDirectory(),
      () => false,
    ))
  );
}

/**
 * Publishes a staged package directory with one atomic exchange, so the package
 * path names a complete package at every instant. The candidate first takes the
 * backup name beside the package path; the exchange then leaves both names as
 * the backup and activation moves would, and nothing has to follow it.
 * `unavailable` means the candidate is staged again and the live package is
 * untouched. An updater killed, or refused, before the exchange leaves the
 * candidate under the backup name beside the serving old package.
 */
async function exchangeStagedPackageRoot(params: {
  stagedRoot: string;
  liveRoot: string;
  backupRoot: string;
  assertCaller: () => void;
  warn: (message: string) => void;
  onUncertain: () => void;
}): Promise<PathExchangeResult> {
  const assertCaller = retainMutationAuthority(params.assertCaller);
  assertCaller();
  try {
    await fs.rename(params.stagedRoot, params.backupRoot);
  } catch (error) {
    // A stage on another filesystem cannot take the backup name; it has not moved.
    return { status: "unavailable", reason: formatErrorMessage(error) };
  }
  try {
    assertCaller();
  } catch (error) {
    // Lost ownership stops here without compensation, as it does everywhere else.
    params.warn(
      `The unpublished package was left at ${params.backupRoot}; ${params.liveRoot} is unchanged.`,
    );
    throw error;
  }
  let exchange: PathExchangeResult;
  try {
    exchange = await exchangePaths(params.backupRoot, params.liveRoot);
  } catch (error) {
    params.onUncertain();
    throw error;
  }
  if (exchange.status === "unavailable") {
    try {
      await fs.rename(params.backupRoot, params.stagedRoot);
    } catch (error) {
      throw new Error(
        `${formatErrorMessage(error)}; ${params.liveRoot} is unchanged and the staged package is at ${params.backupRoot}`,
        { cause: error },
      );
    }
  }
  return exchange;
}

/**
 * Replaces a package root without a publication journal and reports how. With
 * `exchange`, local overrides replay while the old package still serves and one
 * atomic exchange publishes. Otherwise, or when that exchange is unavailable,
 * the old root moves to its backup and the staged one moves into place, which
 * leaves the package path missing between the two moves. The callbacks record
 * each fact at the instant it becomes true, so a throw leaves the caller's
 * rollback state matching the disk.
 */
export async function publishStagedPackageRoot(params: {
  stagedRoot: string;
  liveRoot: string;
  backupRoot: string;
  hadPackage: boolean;
  native: boolean;
  rootLink: Awaited<ReturnType<typeof createNpmPackageRootLinkLifecycle>> | undefined;
  exchange: boolean;
  assertCaller: () => void;
  warnings: string[];
  replayLocalOverrides: (() => Promise<void>) | undefined;
  /** The old root is retained at `backupRoot`. */
  onBackedUp: () => void;
  /** From here a failure owes restoration of the package root. */
  onRollbackOwed: () => void;
  onPublished: () => void;
  /** The package path may hold nothing this update can vouch for. */
  onUnpublished: (uncertain: boolean) => void;
}): Promise<string | null> {
  const { stagedRoot, liveRoot, backupRoot, assertCaller, warnings } = params;
  let publication: string | null = null;
  if (params.exchange) {
    await params.replayLocalOverrides?.();
    const exchange = await exchangeStagedPackageRoot({
      stagedRoot,
      liveRoot,
      backupRoot,
      assertCaller,
      warn: (message) => warnings.push(message),
      onUncertain: () => params.onUnpublished(true),
    });
    if (exchange.status === "exchanged") {
      params.onBackedUp();
      params.onRollbackOwed();
      params.onPublished();
      assertCaller();
      return `published by an atomic exchange (${exchange.route})`;
    }
    publication = `published by two moves (atomic exchange unavailable: ${exchange.reason})`;
  }
  if (params.hadPackage) {
    if (params.native) {
      await movePackageRoot(liveRoot, backupRoot, {
        operation: "backup",
        assertCaller,
        warn: (message) => warnings.push(message),
        onPublished: () => {
          // A published copy owns compensation even if source cleanup is refused.
          params.onBackedUp();
          params.onRollbackOwed();
          assertCaller();
        },
      });
    } else if (params.rootLink) {
      assertCaller();
      const acquisition = await params.rootLink.acquire();
      if (!acquisition.acquired) {
        params.onUnpublished(false);
        throw new Error(acquisition.error);
      }
    } else {
      await backupNpmPackageRoot(liveRoot, backupRoot, assertCaller, warnings);
    }
    if (!params.native) {
      params.onBackedUp();
    }
  }
  if (!params.native || !params.hadPackage) {
    params.onRollbackOwed();
  }
  if (!params.exchange) {
    await params.replayLocalOverrides?.();
  }
  await activateStagedNpmPackageRoot(stagedRoot, liveRoot, undefined, {
    assertCaller,
    onPublished: params.onPublished,
    warnings,
  });
  return publication;
}
