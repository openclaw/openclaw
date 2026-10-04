import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { resolveBunRuntimeInfo } from "../daemon/runtime-paths.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  completePackageActivationCustody,
  inspectPackageActivationCustody,
} from "./package-update-activation-custody.js";
import {
  type PackageActivationDescriptor,
  type PackageActivationRecord,
  createPackageActivationJournal,
  openPackageActivationJournal,
  isPackageActivationComplete,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  encodePackageActivationLauncher,
} from "./package-update-activation-journal.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import {
  packageActivationSqliteEnvironment,
  readPackageActivationSqliteLibrary,
  sealPackageActivationSqliteLibrary,
} from "./package-update-activation-sqlite.js";
import {
  createPackageIntegrityReader,
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

function readPackageActivationRuntime(): Buffer {
  const source = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error("Package publication recovery requires its built sealed helper.");
  }
  return fs.readFileSync(source);
}

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

export function resolvePackageActivationRecoveryCommand(record: PackageActivationRecord): string {
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
  const node = record.descriptor.recoveryNodePath;
  const bytes = fs.readFileSync(helper);
  if (createHash("sha256").update(bytes).digest("hex") !== record.descriptor.helperDigest) {
    throw new Error("Package recovery helper digest changed.");
  }
  return packageActivationRecoveryCommand(
    node,
    anchor,
    record.descriptor.operationId,
    helper,
    readPackageActivationSqliteLibrary(bytes),
  );
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
    const info = await resolveBunRuntimeInfo(node, undefined, runtime.env ?? process.env);
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
  const reader = createPackageIntegrityReader();
  const candidate = await reader.tree(stageRoot);
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
  // operation in the same original store. Legacy/incomplete artifacts refuse.
  assertPackageActivationLayout(anchor);
  const priorJournal = fs.lstatSync(resolvePackageActivationControl(anchor), {
    throwIfNoEntry: false,
  })
    ? openPackageActivationJournal(anchor)
    : undefined;
  const prior = priorJournal?.read();
  if (prior && !isPackageActivationComplete(anchor, prior)) {
    throw new Error("An unresolved package operation already owns this installation.");
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
  const helperBytes = sealPackageActivationSqliteLibrary(
    readPackageActivationRuntime(),
    sqliteLibrary,
  );
  assertCurrent();
  assertRuntime();
  // These objects remain inside the existing stage cleanup owner's prefix
  // until the stable slot records their exact identities. A failed replacement
  // cannot create blocking artifacts over the prior completion receipt.
  const stagedAnchor = await fsp.mkdtemp(path.join(path.dirname(stageRoot), ".activation-anchor-"));
  const anchorIdentity = packageActivationIdentity(stagedAnchor, true);
  const stagedControl = prior
    ? undefined
    : await fsp.mkdtemp(path.join(path.dirname(stageRoot), ".activation-control-"));
  const stagedHelper = stagedControl
    ? path.join(stagedControl, "recovery.mjs")
    : `${stagedAnchor}.recovery.mjs`;
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
      source: stagedControl ? resolvePackageActivationHelper(anchor) : stagedHelper,
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
    journalParentIdentity: packageActivationIdentity(
      stagedControl ?? resolvePackageActivationControl(anchor),
      true,
    ),
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
  const journal =
    priorJournal ??
    createPackageActivationJournal(
      anchor,
      descriptor,
      stagedControl!,
      assertCurrent,
      params.onCustody,
    );
  if (priorJournal && prior) {
    // A reused slot owns the stage as soon as its CAS can commit, even if the
    // acknowledgement is lost. First use latches only at control publication.
    params.onCustody?.(true);
    try {
      priorJournal.replaceCompleted(prior, descriptor, assertCurrent);
    } catch (error) {
      // A proven rollback leaves all new objects in the existing stage owner's
      // prefix. Lost commit acknowledgement or any read uncertainty retains it.
      try {
        assertCurrent();
        priorJournal.assertCurrent(prior);
        if (isPackageActivationComplete(anchor, prior)) {
          params.onCustody?.(false);
        }
      } catch {
        // Preserve the initiating failure and conservatively retain custody.
      }
      throw error;
    }
  }
  const command = packageActivationRecoveryCommand(
    node,
    anchor,
    descriptor.operationId,
    undefined,
    sqliteLibrary,
  );
  assertCurrent();
  // A replacement's bootstrap command is valid only while that recorded helper
  // remains staged. Never advertise the stable name before its inode is present.
  if (prior) {
    params.options.onPrepared(
      `${packageActivationRecoveryCommand(node, anchor, descriptor.operationId, stagedHelper, sqliteLibrary)} status`,
    );
  }
  await completePackageActivationCustody(anchor, journal, assertCurrent, () =>
    params.options.onPrepared(`${command} status`),
  );
  const initial = journal.read();
  // Carry in-process entry observations without expanding the durable journal.
  initial.descriptor.previous = params.previous;
  initial.descriptor.candidate = candidate;
  return { anchor, journal, command, initial };
}
