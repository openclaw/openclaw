import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { hasErrnoCode } from "../infra/errno.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolvePrefix } from "./store.js";

type CheckoutIdentity = NonNullable<UpdateRunParams["checkout"]>;

/** Git releases are linked worktrees; their common directory, not their root, is stable. */
export async function resolveUpdateInstallationIdentity(root: string): Promise<CheckoutIdentity> {
  const git = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 10_000 },
  ).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  });
  if (git?.code === 0) {
    return { gitCommonDir: await fs.realpath(git.stdout.trim()) };
  }
  const canonicalRoot = await fs.realpath(root);
  const prefix = await fs.realpath(resolvePrefix()).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return path.resolve(resolvePrefix());
  });
  // Package releases and their original forwarding installation share the launcher's slot.
  const launcher = await fs
    .readFile(path.join(root, ".openclaw-launcher"), "utf8")
    .then((marker) => fs.realpath(path.resolve(marker.trim())))
    .catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return undefined;
    });
  const release = path.relative(path.join(prefix, "releases"), canonicalRoot).split(path.sep);
  const managed =
    (release.length === 2 && release[0] !== ".." && release[1] === "openclaw") ||
    launcher === path.join(prefix, "openclaw-launcher.mjs");
  return { packageRoot: managed ? path.join(prefix, "openclaw") : canonicalRoot };
}

/** Refuse before creating a run or changing the one launcher slot shared by the state directory. */
export async function updateInstallationMismatch(
  checkout: CheckoutIdentity,
  installedRoot: string,
): Promise<string | undefined> {
  const installed = await resolveUpdateInstallationIdentity(installedRoot);
  const matches =
    "gitCommonDir" in checkout && "gitCommonDir" in installed
      ? checkout.gitCommonDir === installed.gitCommonDir
      : "packageRoot" in checkout &&
        "packageRoot" in installed &&
        checkout.packageRoot === installed.packageRoot;
  if (matches) {
    return undefined;
  }
  const command = [process.execPath, path.join(installedRoot, "openclaw.mjs"), "update"]
    .map((value) => value.replace(/[^\w@%+=:,./-]/gu, "\\$&"))
    .join(" ");
  return `This state directory uses the OpenClaw installation at ${installedRoot}, not the invoking installation. Nothing changed. To update that installation, run: ${command}`;
}

export async function checkUpdateInstallationSlot(root: string): Promise<void> {
  const target = await fs
    .realpath(path.join(resolvePrefix(), "openclaw"))
    .catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return undefined;
    });
  if (!target) {
    return;
  }
  const mismatch = await updateInstallationMismatch(
    await resolveUpdateInstallationIdentity(root),
    target,
  );
  if (mismatch) {
    throw new Error(mismatch);
  }
}
