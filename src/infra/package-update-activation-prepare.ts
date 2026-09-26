import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
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
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import { capturePackageActivationPreviousRuntime } from "./package-update-activation-target.js";
import {
  createPackageIntegrityReader,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";
import type { PackageActivationOptions } from "./package-update-swap-contract.js";
import { isSupportedNodeVersion } from "./runtime-guard.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

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
): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(node)} ${quote(helper)} --anchor ${quote(anchor)} --operation ${quote(operationId)}`;
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
  const node =
    record.descriptor.recoveryNodePath ?? record.descriptor.previousRuntime?.nodePath ?? "node";
  return packageActivationRecoveryCommand(node, anchor, record.descriptor.operationId, helper);
}

export async function preparePackageActivationJournal(
  params: PackageActivationPreparation,
  assertion = params.options.fence.assertCurrent.bind(params.options.fence),
) {
  const assertCurrent = retainMutationAuthority(assertion);
  assertCurrent();
  const authority = captureUpdateCommandExecutorAuthority(
    params.options.fence,
    params.options.runId,
  );
  assertCurrent();
  if (process.platform === "win32" || authority.installKey !== params.liveRoot) {
    throw new Error("Package publication recovery requires its original POSIX npm directory.");
  }
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  const parent = path.dirname(anchor);
  if (fs.realpathSync(parent) !== parent || fs.realpathSync(params.binDir) !== params.binDir) {
    throw new Error("Package publication recovery requires canonical installation parents.");
  }
  const node = fs.realpathSync(params.options.nodeRunner);
  for (const root of [params.liveRoot, params.stageRoot, anchor]) {
    if (node === root || node.startsWith(`${root}${path.sep}`)) {
      throw new Error("Recovery requires an external Node executable.");
    }
  }
  const version = spawnSync(node, ["--version"], {
    env: {},
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (version.status !== 0 || !isSupportedNodeVersion(version.stdout.trim().replace(/^v/u, ""))) {
    throw new Error("Recovery requires a supported external Node executable.");
  }
  const previousRuntime = params.options.runId
    ? await capturePackageActivationPreviousRuntime({
        root: params.liveRoot,
        previous: params.previous,
        nodePath: node,
        nodeVersion: version.stdout.trim(),
        assertCurrent,
      })
    : undefined;
  const reader = createPackageIntegrityReader();
  const candidate = await reader.tree(params.stageRoot);
  const launchers = [];
  for (const entry of params.launchers) {
    const source = path.join(params.launcherRoot, entry.name);
    const destination = path.join(params.binDir, entry.name);
    launchers.push({
      ...entry,
      candidate: encodePackageActivationLauncher(await reader.launcher(source)),
      candidateIdentity: packageActivationIdentity(source, "launcher"),
      previousIdentity:
        entry.previous === null ? null : packageActivationIdentity(destination, "launcher"),
    });
  }
  const parentIdentity = packageActivationIdentity(parent, true);
  const binIdentity = packageActivationIdentity(params.binDir, true);
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
    { name: "candidate" as const, source: params.stageRoot, identity: candidate.identity },
    {
      name: "launchers" as const,
      source: params.launcherRoot,
      identity: packageActivationIdentity(params.launcherRoot, true),
    },
    ...(params.previousLauncherRoot
      ? [
          {
            name: "previous-launchers" as const,
            source: params.previousLauncherRoot,
            identity: packageActivationIdentity(params.previousLauncherRoot, true),
          },
        ]
      : []),
  ].map((entry) => ({
    name: entry.name,
    source: entry.source,
    identity: entry.identity,
    sourceParentIdentity: packageActivationIdentity(path.dirname(entry.source), true),
  }));
  // Preflight the sealed helper before creating any blocking recovery artifact.
  const helperBytes = readPackageActivationRuntime();
  assertCurrent();
  // These objects remain inside the existing stage cleanup owner's prefix
  // until the stable slot records their exact identities. A failed replacement
  // cannot create blocking artifacts over the prior completion receipt.
  const stagedAnchor = await fsp.mkdtemp(
    path.join(path.dirname(params.stageRoot), ".activation-anchor-"),
  );
  const anchorIdentity = packageActivationIdentity(stagedAnchor, true);
  const stagedControl = prior
    ? undefined
    : await fsp.mkdtemp(path.join(path.dirname(params.stageRoot), ".activation-control-"));
  const stagedHelper = stagedControl
    ? path.join(stagedControl, "recovery.mjs")
    : `${stagedAnchor}.recovery.mjs`;
  assertCurrent();
  fs.writeFileSync(stagedHelper, helperBytes, { flag: "wx", mode: 0o600, flush: true });
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
      sourceParentIdentity: packageActivationIdentity(path.dirname(stagedAnchor), true),
    },
    {
      name: "helper",
      source: stagedControl ? resolvePackageActivationHelper(anchor) : stagedHelper,
      identity: helperIdentity,
      sourceParentIdentity: packageActivationIdentity(path.dirname(stagedHelper), true),
    },
  );
  const descriptor = {
    version: 1 as const,
    layout: "external-helper" as const,
    operationId: randomUUID(),
    recoveryNodePath: node,
    ...(params.options.runId ? { originalRunId: params.options.runId, previousRuntime } : {}),
    authority,
    anchorIdentity,
    parentIdentity,
    journalParentIdentity: packageActivationIdentity(
      stagedControl ?? resolvePackageActivationControl(anchor),
      true,
    ),
    binDir: params.binDir,
    binIdentity,
    originalStageRoot: params.stageRoot,
    previous: params.previous,
    candidate,
    launcherRootIdentity: packageActivationIdentity(params.launcherRoot, true),
    previousLauncherRootIdentity: params.previousLauncherRoot
      ? packageActivationIdentity(params.previousLauncherRoot, true)
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
  const command = packageActivationRecoveryCommand(node, anchor, descriptor.operationId);
  assertCurrent();
  // A replacement's bootstrap command is valid only while that recorded helper
  // remains staged. Never advertise the stable name before its inode is present.
  if (prior) {
    params.options.onPrepared(
      `${packageActivationRecoveryCommand(node, anchor, descriptor.operationId, stagedHelper)} status`,
    );
  }
  await completePackageActivationCustody(anchor, journal, assertCurrent, () =>
    params.options.onPrepared(`${command} status`),
  );
  return { anchor, journal, command };
}
