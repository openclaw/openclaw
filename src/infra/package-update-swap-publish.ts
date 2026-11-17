import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  activateStagedNpmPackageRoot,
  backupNpmPackageRoot,
  movePackageRoot,
} from "./package-update-filesystem.js";
import type { PackageIntegrityFingerprint } from "./package-update-integrity.js";
import type { createNpmPackageRootLinkLifecycle } from "./package-update-npm-root.js";
import type { createPublicationOwner } from "./package-update-publication-owner.js";
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
    exchange = await exchangePaths(params.backupRoot, params.liveRoot, assertCaller);
  } catch (error) {
    params.onUncertain();
    throw error;
  }
  if (exchange.status === "unavailable") {
    assertCaller();
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

const describePublication = (exchange: PathExchangeResult) =>
  exchange.status === "exchanged"
    ? `published by an atomic exchange (${exchange.route})`
    : `published by two moves (atomic exchange unavailable: ${exchange.reason})`;

/**
 * Publishes through the publication journal and reports how. Where the journal
 * can exchange, local overrides are captured from the old package at its path
 * before the journal publishes, because an exchange never leaves it at a backup
 * location first; the journal then decides between the exchange and its two moves.
 */
export async function publishJournaledPackageRoot(params: {
  activation: Pick<
    ReturnType<typeof createPublicationOwner>,
    "publish" | "assertCurrent" | "exchangeOutcome"
  > & { anchor: string };
  liveRoot: string;
  backupRoot: string;
  warnings: string[];
  replayLocalOverrides:
    | ((roots: { backupRoot: string; packageRoot: string }) => Promise<void>)
    | undefined;
  /** The previous package is retained in the journal's custody. */
  onDisplaced: (previous: PackageIntegrityFingerprint) => void;
}): Promise<string | null> {
  const { activation } = params;
  // The same question the journal asks before it tries the exchange.
  const captureFirst = supportsPathExchange();
  const replay = async (previousRoot: string) => {
    activation.assertCurrent();
    await params.replayLocalOverrides?.({
      backupRoot: previousRoot,
      packageRoot: path.join(activation.anchor, "candidate"),
    });
    activation.assertCurrent();
  };
  if (captureFirst) {
    await replay(params.liveRoot);
  }
  await activation.publish(false, async (previous, copied) => {
    if (copied) {
      params.warnings.push("EXDEV during package backup rename; using a verified rollback copy.");
    }
    params.onDisplaced(previous);
    if (!captureFirst) {
      await replay(params.backupRoot);
    }
  });
  const exchange = activation.exchangeOutcome();
  return exchange ? describePublication(exchange) : null;
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
    publication = describePublication(exchange);
    if (exchange.status === "exchanged") {
      params.onBackedUp();
      params.onRollbackOwed();
      params.onPublished();
      assertCaller();
      return publication;
    }
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
