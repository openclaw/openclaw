import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { resolveBunRuntimeInfo } from "../daemon/runtime-paths.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  completePackageActivationCustody,
  inspectPackageActivationCustody,
  packageActivationIdentityOrAbsent,
} from "./package-update-activation-custody.js";
import {
  type PackageActivationDescriptor,
  type PackageActivationJournal,
  type PackageActivationRecord,
  createPackageActivationJournal,
  openPackageActivationSettlementJournal,
  isPackageActivationComplete,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  resolvePackageActivationHelper,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  encodePackageActivationLauncher,
} from "./package-update-activation-journal.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import {
  inspectPackageActivationLease,
  isUnpublishedPreparation,
} from "./package-update-activation-settlement.js";
import {
  packageActivationSqliteEnvironment,
  readPackageActivationSqliteLibrary,
  sealPackageActivationSqliteLibrary,
} from "./package-update-activation-sqlite.js";
import {
  createPackageIntegrityReader,
  isPackageIntegrityResourceError,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";
import type { PackageActivationOptions } from "./package-update-swap-contract.js";
import { isSupportedNodeVersion } from "./runtime-guard.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

export type PackageActivationPreparation = {
  options: PackageActivationOptions;
  liveRoot: string;
  stageRoot: string;
  launcherRoot: string;
  binDir: string;
  previous: PackageIntegrityFingerprint;
  previousLauncherRoot?: string;
  onCustody?: (retained: boolean) => void;
  launchers: Array<{ name: string; previous: string | null }>;
};

export class PackageActivationArchiveError extends Error {}

function packageActivationRecoveryCommand(
  node: string,
  anchor: string,
  operationId: string,
  helper = resolvePackageActivationHelper(anchor),
  sqliteLibrary?: string,
): string {
  const prefix = sqliteLibrary ? `${packageActivationSqliteEnvironment(sqliteLibrary)} ` : "";
  return `${prefix}${quoteCliArg(node)} ${quoteCliArg(helper)} --anchor ${quoteCliArg(anchor)} --operation ${quoteCliArg(operationId)}`;
}

function readRecordedPackageActivationHelper(record: PackageActivationRecord) {
  const anchor = resolvePackageActivationAnchor(record.descriptor.authority.installKey);
  let helper = resolvePackageActivationHelper(anchor);
  if (record.phase === "preparing") {
    // Replacement already records the staged helper before its transfer. Expose
    // that durable locator even when no command-print acknowledgement survived.
    const custody = inspectPackageActivationCustody(anchor, record).find(
      (entry) => entry.name === "helper",
    );
    if (!custody) {
      throw new Error("Package bootstrap helper custody is missing.");
    }
    helper = custody.moved ? custody.destination : custody.source;
  }
  const bytes = fs.readFileSync(helper);
  if (createHash("sha256").update(bytes).digest("hex") !== record.descriptor.helperDigest) {
    throw new Error("Package recovery helper digest changed.");
  }
  return { anchor, helper, bytes };
}

export function resolvePackageActivationRecoveryCommand(record: PackageActivationRecord): string {
  const { anchor, helper, bytes } = readRecordedPackageActivationHelper(record);
  return packageActivationRecoveryCommand(
    record.descriptor.recoveryNodePath,
    anchor,
    record.descriptor.operationId,
    helper,
    readPackageActivationSqliteLibrary(bytes),
  );
}

/**
 * Whether this build sealed the recorded recovery helper. Its own recovery code
 * is then that helper's, so resuming the operation in process runs what the
 * printed recovery command would. Any other build leaves it to that command.
 */
function isPackageActivationHelperBuild(record: PackageActivationRecord): boolean {
  const { bytes } = readRecordedPackageActivationHelper(record);
  let own: Buffer;
  try {
    own = fs.readFileSync(resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint));
  } catch (error) {
    // A source checkout has no built helper, so it sealed none.
    return ignoreMissingPath(error) ?? false;
  }
  return sealPackageActivationSqliteLibrary(own, readPackageActivationSqliteLibrary(bytes)).equals(
    bytes,
  );
}

const REINSTALL_NEXT_STEP =
  "reinstall openclaw with your package manager (https://docs.openclaw.ai/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun), then run openclaw update, which retires the superseded operation";

/**
 * Says how resuming a killed publication ends, or nothing when this update must
 * not resume it. Resuming runs the recovery the printed command runs, under a
 * fresh claim on the recorded lease store: that claim is what proves the original
 * updater gone, so the store must be the recorded one. It never replaces an
 * installed package: the untouched previous one stays and the publication aborts,
 * or none is installed and the recorded candidate is published into the gap.
 */
export function inspectResumablePackagePublication(
  journal: Pick<PackageActivationJournal, "inspectRemount">,
  record: PackageActivationRecord,
): "abort" | "publish" | undefined {
  const installed = packageActivationIdentityOrAbsent(record.descriptor.authority.installKey, true);
  // Only a publication under way displaces the package it then replaces.
  const resumable =
    installed === null
      ? record.phase === "publishing"
      : installed === record.descriptor.previous.identity &&
        ["preparing", "prepared", "publishing"].includes(record.phase) &&
        !isUnpublishedPreparation(record, installed);
  const lease = resumable && inspectPackageActivationLease(record.descriptor.authority);
  if (
    !lease ||
    !lease.current ||
    lease.changed ||
    journal.inspectRemount(record) ||
    !isPackageActivationHelperBuild(record)
  ) {
    return undefined;
  }
  return installed === null ? "publish" : "abort";
}

/** Adds what resuming a killed publication did to the settlement that closed it. */
export function noteResumedPackagePublication<T extends { detail: string | undefined }>(
  settled: T,
  outcome: "abort" | "publish",
  preview = false,
) {
  const resumed = `${
    outcome === "abort"
      ? "The publication was interrupted before its candidate was installed and is aborted: the installed package is kept and the unpublished candidate is discarded."
      : "The publication was interrupted after the previous package left the package path: its recorded candidate is published."
  }${preview ? " A real update does this only after it claims the installation, which the original updater must have released." : ""}`;
  return { ...settled, resumed, detail: settled.detail ? `${resumed} ${settled.detail}` : resumed };
}

/** A dry run's settlement: what a real update would resume, which it cannot claim to prove. */
export function previewResumedPackagePublication(
  record: PackageActivationRecord,
  outcome: "abort" | "publish",
) {
  return noteResumedPackagePublication(
    {
      operationId: record.descriptor.operationId,
      reason:
        outcome === "abort" ? "publication-not-started" : "publication-settled-external-change",
      retained: undefined,
      detail: undefined,
    },
    outcome,
    true,
  );
}

/** A resumption its own recovery refused: keep the reason and name a step that works. */
export function refusePackagePublicationResume(record: PackageActivationRecord, cause: unknown) {
  // Losing the claim is its own refusal, with its own next step.
  return cause instanceof UpdateCommandRecoveryPendingError
    ? cause
    : new Error(
        `Package publication ${record.descriptor.operationId} cannot be resumed: its recorded recovery refuses the installation as it is now. Retry once; if it refuses again, ${REINSTALL_NEXT_STEP}. Cause: ${formatErrorMessage(cause)}`,
        { cause },
      );
}

/** Without the recorded lease store, replaced or missing, nothing proves the original updater gone. */
export function explainLostPublicationLease(error: unknown): unknown {
  return error instanceof Error &&
    "code" in error &&
    (error.code === "managed-handoff-lease-identity-changed" || error.code === "ENOENT")
    ? Object.assign(
        new Error(
          `${error.message} If repair reports the same, no updater can prove that this unfinished package publication's original updater has exited: ${REINSTALL_NEXT_STEP}.`,
          { cause: error },
        ),
        { code: error.code },
      )
    : error;
}

export async function preparePackageActivationJournal(
  params: PackageActivationPreparation,
  assertion = params.options.fence.assertCurrent.bind(params.options.fence),
) {
  const assertCurrent = retainMutationAuthority(assertion);
  assertCurrent();
  const authority = captureUpdateCommandExecutorAuthority(params.options.fence);
  assertCurrent();
  const liveRoot = resolveUpdateInstallRoot(params.liveRoot);
  if (process.platform === "win32" || authority.installKey !== liveRoot) {
    throw new Error("Package publication recovery requires its original POSIX npm directory.");
  }
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  const parent = path.dirname(anchor);
  if (fs.realpathSync(parent) !== parent) {
    throw new Error("Package publication recovery requires canonical installation parents.");
  }
  const stageRoot = resolveUpdateInstallRoot(params.stageRoot);
  const launcherRoot = resolveUpdateInstallRoot(params.launcherRoot);
  const binDir = resolveUpdateInstallRoot(params.binDir);
  const previousLauncherRoot = params.previousLauncherRoot
    ? resolveUpdateInstallRoot(params.previousLauncherRoot)
    : undefined;
  const runtime = params.options.runtime;
  const node = fs.realpathSync(runtime.path);
  const assertRuntime = () => {
    if (node !== runtime.path || packageActivationRuntimeIdentity(node) !== runtime.identity) {
      throw new Error("The selected package recovery executable changed after runtime preflight.");
    }
  };
  assertRuntime();
  for (const root of [liveRoot, stageRoot, anchor]) {
    if (node === root || node.startsWith(`${root}${path.sep}`)) {
      throw new Error("Recovery requires an external Node executable.");
    }
  }
  let sqliteLibrary: string | undefined;
  if (runtime.kind === "bun") {
    const info = await resolveBunRuntimeInfo(node, runtime.env ?? process.env);
    if (info.status !== "supported") {
      throw new Error("Recovery requires a supported external Bun executable.", {
        cause: info.status === "probe-failed" ? info.error : undefined,
      });
    }
    sqliteLibrary = info.sqliteLibraryPath;
  } else {
    const version = spawnSync(node, ["--version"], {
      env: {},
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (version.status !== 0 || !isSupportedNodeVersion(version.stdout.trim().replace(/^v/u, ""))) {
      throw new Error("Recovery requires a supported external Node executable.");
    }
  }
  assertCurrent();
  assertRuntime();
  let candidate: PackageActivationDescriptor["candidate"];
  try {
    candidate = await createPackageIntegrityReader().tree(stageRoot);
  } catch (error) {
    if (!isPackageIntegrityResourceError(error)) {
      throw error;
    }
    const identity = await createPackageIntegrityReader().directoryIdentity(stageRoot);
    if (!identity) {
      throw error;
    }
    candidate = identity;
    params.options.onWarning?.(
      "candidate package fingerprint incomplete; activation requires the directory identity, package version and launchers; full package contents are unverified",
    );
  }
  // Optional content verification must not consume the launcher reader's deadline.
  const reader = createPackageIntegrityReader();
  const launchers = [];
  for (const entry of params.launchers) {
    const source = path.join(launcherRoot, entry.name);
    const destination = path.join(binDir, entry.name);
    launchers.push({
      ...entry,
      candidate: encodePackageActivationLauncher(await reader.launcher(source)),
      candidateIdentity: packageActivationIdentity(source, "launcher"),
      previousIdentity:
        entry.previous === null ? null : packageActivationIdentity(destination, "launcher"),
    });
  }
  const parentIdentity = packageActivationIdentity(parent, "parent");
  const binIdentity = packageActivationIdentity(binDir, "parent");
  if (
    candidate.identity.split(":")[0] !== parentIdentity.split(":")[0] ||
    params.previous.identity.split(":")[0] !== parentIdentity.split(":")[0]
  ) {
    throw new Error("Package publication recovery requires same-filesystem directories.");
  }
  // A completed receipt may be replaced only by this new, genuinely admitted
  // operation under its current fence. Legacy/incomplete artifacts refuse.
  assertPackageActivationLayout(anchor);
  const priorJournal = fs.lstatSync(resolvePackageActivationControl(anchor), {
    throwIfNoEntry: false,
  })
    ? openPackageActivationSettlementJournal(anchor)
    : undefined;
  const prior = priorJournal?.read();
  if (prior && !isPackageActivationComplete(anchor, prior)) {
    throw new Error(
      "An unresolved package operation already owns this installation. Run openclaw update repair before retrying.",
    );
  }
  if (priorJournal && prior) {
    try {
      priorJournal.archiveSettled(prior, assertCurrent);
    } catch (error) {
      assertCurrent();
      if (fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
        priorJournal.assertCurrent(prior);
      }
      throw new PackageActivationArchiveError(
        `Completed package recovery evidence retained; standalone publication repair is unavailable for this update: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
  const preparation: PackageActivationDescriptor["preparation"] = [
    { name: "candidate" as const, source: stageRoot, identity: candidate.identity },
    {
      name: "launchers" as const,
      source: launcherRoot,
      identity: packageActivationIdentity(launcherRoot, true),
    },
    ...(previousLauncherRoot
      ? [
          {
            name: "previous-launchers" as const,
            source: previousLauncherRoot,
            identity: packageActivationIdentity(previousLauncherRoot, true),
          },
        ]
      : []),
  ].map((entry) => ({
    name: entry.name,
    source: entry.source,
    identity: entry.identity,
    sourceParentIdentity: packageActivationIdentity(path.dirname(entry.source), "parent"),
  }));
  // Preflight the sealed helper before creating any blocking recovery artifact.
  const source = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error("Package publication recovery requires its built sealed helper.");
  }
  const helperBytes = sealPackageActivationSqliteLibrary(fs.readFileSync(source), sqliteLibrary);
  assertCurrent();
  assertRuntime();
  // These objects remain inside the existing stage cleanup owner's prefix
  // until the stable slot records their exact identities. A failed replacement
  // cannot create blocking artifacts over the prior completion receipt.
  const stagedAnchor = await fsp.mkdtemp(path.join(path.dirname(stageRoot), ".activation-anchor-"));
  const anchorIdentity = packageActivationIdentity(stagedAnchor, true);
  const stagedControl = await fsp.mkdtemp(
    path.join(path.dirname(stageRoot), ".activation-control-"),
  );
  const stagedHelper = path.join(stagedControl, "recovery.mjs");
  assertCurrent();
  const helperFd = fs.openSync(stagedHelper, "wx", 0o600);
  try {
    fs.writeFileSync(helperFd, helperBytes);
    fs.fsyncSync(helperFd);
  } finally {
    fs.closeSync(helperFd);
  }
  // The durable journal may refer to these staged objects immediately after
  // its CAS. Persist their contents and names before handing cleanup custody off.
  for (const directory of new Set([
    stagedAnchor,
    path.dirname(stagedHelper),
    path.dirname(stagedAnchor),
  ])) {
    assertCurrent();
    requireDirectorySync(await syncDirectory(directory), "Package preparation staging");
  }
  assertCurrent();
  const helperIdentity = packageActivationIdentity(stagedHelper, false);
  const helperDigest = createHash("sha256").update(helperBytes).digest("hex");
  preparation.unshift(
    {
      name: "anchor",
      source: stagedAnchor,
      identity: anchorIdentity,
      sourceParentIdentity: packageActivationIdentity(path.dirname(stagedAnchor), "parent"),
    },
    {
      name: "helper",
      source: resolvePackageActivationHelper(anchor),
      identity: helperIdentity,
      sourceParentIdentity: packageActivationIdentity(path.dirname(stagedHelper), "parent"),
    },
  );
  const descriptor = {
    version: 1 as const,
    layout: "external-helper" as const,
    operationId: randomUUID(),
    recoveryNodePath: node,
    authority,
    anchorIdentity,
    parentIdentity,
    journalParentIdentity: packageActivationIdentity(stagedControl, true),
    binDir,
    binIdentity,
    originalStageRoot: stageRoot,
    previous: params.previous,
    candidate,
    launcherRootIdentity: packageActivationIdentity(launcherRoot, true),
    previousLauncherRootIdentity: previousLauncherRoot
      ? packageActivationIdentity(previousLauncherRoot, true)
      : null,
    helperDigest,
    helperIdentity,
    preparation,
    launchers,
  };
  const journal = createPackageActivationJournal(
    anchor,
    descriptor,
    stagedControl,
    assertCurrent,
    params.onCustody,
  );
  const command = packageActivationRecoveryCommand(
    node,
    anchor,
    descriptor.operationId,
    undefined,
    sqliteLibrary,
  );
  assertCurrent();
  await completePackageActivationCustody(anchor, journal, assertCurrent, () =>
    params.options.onPrepared(`${command} status`),
  );
  const initial = journal.read();
  // Carry in-process entry observations without expanding the durable journal.
  initial.descriptor.previous = params.previous;
  initial.descriptor.candidate = candidate;
  return { anchor, journal, command, initial };
}
