import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readPackageVersion } from "../infra/package-json.js";
import { resolveUpdateInstallKind } from "../infra/update-check.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { detectGlobalInstallManagerForRoot } from "../infra/update-global.js";
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
  const entry = installedRoot.startsWith(path.join(resolvePrefix(), "releases") + path.sep)
    ? path.join(resolvePrefix(), "openclaw-launcher.mjs")
    : path.join(installedRoot, "openclaw.mjs");
  const command = [process.execPath, entry, "update"]
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

/** Explicit local package adoption is not installation identity and never admits an RPC caller. */
export async function resolveInstalledPackageFrontend(root: string) {
  const prefix = resolvePrefix();
  const selected = await fs.realpath(path.join(prefix, "openclaw")).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  });
  if (!selected) {
    return undefined;
  }
  if (!(await fs.stat(root)).isDirectory()) {
    return undefined;
  }
  const [frontend, resident] = await Promise.all([
    resolveUpdateInstallationIdentity(root),
    resolveUpdateInstallationIdentity(selected),
  ]);
  if (
    !("packageRoot" in frontend) ||
    !("packageRoot" in resident) ||
    frontend.packageRoot === resident.packageRoot ||
    !selected.startsWith(path.join(await fs.realpath(prefix), "releases") + path.sep) ||
    (await resolveUpdateInstallKind(root)) !== "package" ||
    (await detectGlobalInstallManagerForRoot(runCommandWithTimeout, root, 10_000)) !== "npm"
  ) {
    return undefined;
  }
  const [version, selectedVersion, buildId, selectedBuildId] = await Promise.all([
    readPackageVersion(root),
    readPackageVersion(selected),
    readBuiltGatewayBuildId(root),
    readBuiltGatewayBuildId(selected),
  ]);
  return version && selectedVersion
    ? { root, selected, version, selectedVersion, buildId, selectedBuildId }
    : undefined;
}
