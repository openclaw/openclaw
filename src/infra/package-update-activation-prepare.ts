import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import {
  createPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import {
  PACKAGE_ACTIVATION_HELPER,
  packageActivationRuntimeEntrypoint,
} from "./package-update-activation-runtime-assets.js";
import {
  createPackageIntegrityReader,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";
import { isSupportedNodeVersion } from "./runtime-guard.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type PackageActivationOptions = {
  fence: UpdateRecoveryFence;
  nodeRunner: string;
  onPrepared: (command: string) => void;
  onUnavailable?: (message: string) => void;
};
export type PackageActivationPreparation = {
  options: PackageActivationOptions;
  liveRoot: string;
  stageRoot: string;
  launcherRoot: string;
  binDir: string;
  previous: PackageIntegrityFingerprint;
  previousLauncherRoot?: string;
  launchers: Array<{ name: string; previous: string | null }>;
};

function stagePackageActivationRuntime(anchor: string, assertCurrent: () => void): string {
  const source = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error("Package publication recovery requires its built sealed helper.");
  }
  const bytes = fs.readFileSync(source);
  assertCurrent();
  fs.writeFileSync(path.join(anchor, PACKAGE_ACTIVATION_HELPER), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return createHash("sha256").update(bytes).digest("hex");
}

export async function preparePackageActivationJournal(params: PackageActivationPreparation) {
  const authority = captureUpdateCommandExecutorAuthority(params.options.fence);
  const assertCurrent = params.options.fence.assertCurrent;
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
  const reader = createPackageIntegrityReader();
  const candidate = await reader.tree(params.stageRoot);
  const launchers = [];
  for (const entry of params.launchers) {
    const source = path.join(params.launcherRoot, entry.name);
    const destination = path.join(params.binDir, entry.name);
    launchers.push({
      ...entry,
      candidate: await reader.launcher(source),
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
  assertCurrent();
  await fsp.mkdir(anchor, { mode: 0o700 });
  // From the first transfer onward the anchor owns these objects, even when a
  // later journal commit loses its acknowledgement. Stage-finally must not remove them.
  const anchorIdentity = packageActivationIdentity(anchor, true);
  const helperDigest = stagePackageActivationRuntime(anchor, assertCurrent);
  assertCurrent();
  await fsp.rename(params.stageRoot, path.join(anchor, "candidate"));
  assertCurrent();
  await fsp.rename(params.launcherRoot, path.join(anchor, "launchers"));
  if (params.previousLauncherRoot) {
    assertCurrent();
    await fsp.rename(params.previousLauncherRoot, path.join(anchor, "previous-launchers"));
  }
  const journal = createPackageActivationJournal(
    anchor,
    {
      version: 1,
      operationId: randomUUID(),
      authority,
      anchorIdentity,
      parentIdentity,
      binDir: params.binDir,
      binIdentity,
      originalStageRoot: params.stageRoot,
      previous: params.previous,
      candidate,
      launcherRootIdentity: packageActivationIdentity(path.join(anchor, "launchers"), true),
      previousLauncherRootIdentity: params.previousLauncherRoot
        ? packageActivationIdentity(path.join(anchor, "previous-launchers"), true)
        : null,
      helperDigest,
      launchers,
    },
    assertCurrent,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(node)} ${quote(path.join(anchor, PACKAGE_ACTIVATION_HELPER))}`;
  assertCurrent();
  params.options.onPrepared(`${command} status`);
  return { anchor, journal, command };
}
