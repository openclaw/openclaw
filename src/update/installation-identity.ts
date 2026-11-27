import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolveGatewayService } from "../daemon/service.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readGatewayLockProcessCmdline } from "../infra/gateway-lock-process.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { readPackageVersion } from "../infra/package-json.js";
import { resolveUpdateInstallKind } from "../infra/update-check.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { detectGlobalInstallManagerForRoot } from "../infra/update-global.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import { resolveLegacyGatewayManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-legacy-store.js";
import { ignoreNonCleanupCommandError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolvePrefix } from "./store.js";

type CheckoutIdentity = NonNullable<UpdateRunParams["checkout"]>;

export class UnverifiedForegroundUpdateOwnerError extends Error {
  override name = "UnverifiedForegroundUpdateOwnerError";

  constructor(pid: number) {
    super(
      `Cannot verify which installation the live foreground Gateway (PID ${pid}) uses. Run the update from that Gateway in Control UI or with operator access (\`openclaw update\`), or stop the Gateway through its owner and rerun this command.`,
    );
  }
}

/** Git releases are linked worktrees; their common directory, not their root, is stable. */
export async function resolveUpdateInstallationIdentity(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckoutIdentity> {
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
  const prefix = await fs.realpath(resolvePrefix(env)).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return path.resolve(resolvePrefix(env));
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const installed = await resolveUpdateInstallationIdentity(installedRoot, env);
  const matches =
    "gitCommonDir" in checkout && "gitCommonDir" in installed
      ? checkout.gitCommonDir === installed.gitCommonDir
      : "packageRoot" in checkout &&
        "packageRoot" in installed &&
        checkout.packageRoot === installed.packageRoot;
  if (matches) {
    return undefined;
  }
  const entry = installedRoot.startsWith(path.join(resolvePrefix(env), "releases") + path.sep)
    ? path.join(resolvePrefix(env), "openclaw-launcher.mjs")
    : path.join(installedRoot, "openclaw.mjs");
  const command = [process.execPath, entry, "update"]
    .map((value) => value.replace(/[^\w@%+=:,./-]/gu, "\\$&"))
    .join(" ");
  return `This state directory uses the OpenClaw installation at ${installedRoot}, not the invoking installation. Nothing changed. To update that installation, run: ${command}`;
}

/** A node-only package stays with its installer; no Gateway can activate a release trial. */
export async function isNodeOnlyUpdateInstallation(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const gateway = resolveGatewayService();
  if (
    (await gateway.hasInstalledDefinition?.({ env }).catch(ignoreNonCleanupCommandError)) !== false
  ) {
    return false;
  }
  if (
    (await resolveNodeService()
      .hasInstalledDefinition?.({ env })
      .catch(ignoreNonCleanupCommandError)) !== true
  ) {
    return false;
  }
  return (
    (await readActiveGatewayLockIdentity({ env, requireInspection: true, timeoutMs: 10_000 })
      .then((owner) => !owner)
      .catch(ignoreNonCleanupCommandError)) === true
  );
}

export async function checkUpdateInstallationSlot(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const currentDatabasePath = resolveManagedUpdateLeaseDatabasePath();
  const key = resolveUpdateInstallRoot(root);
  for (const databasePath of [
    currentDatabasePath,
    resolveLegacyGatewayManagedUpdateLeaseDatabasePath(currentDatabasePath),
  ]) {
    if (!databasePath) {
      continue;
    }
    const store = await prepareManagedHandoffLeaseStore({
      databasePath,
      serviceManagerEnv: resolveServiceManagerEnv(env),
    });
    let observed;
    try {
      observed = store.read(key);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (observed.kind === "absent") {
      continue;
    }
    const lease = observed.kind === "current" ? observed.lease : store.readLegacyParent(key);
    if (
      lease &&
      (store.processState(lease.helper) === "live" || store.processState(lease.executor) === "live")
    ) {
      throw new Error(
        "An in-place updater is still using this installation. Let that update finish, then retry.",
      );
    }
  }
  const target = await fs
    .realpath(path.join(resolvePrefix(env), "openclaw"))
    .catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return undefined;
    });
  const installedRoots: string[] = [];
  if (target) {
    installedRoots.push(target);
  } else {
    const command = await resolveGatewayService()
      .readCommand(env, { requireEffective: true })
      .catch(ignoreNonCleanupCommandError);
    const layout = await summarizeGatewayServiceLayout(command).catch(ignoreNonCleanupCommandError);
    if (layout?.packageRootReal) {
      installedRoots.push(layout.packageRootReal);
    }
    const owner = await readActiveGatewayLockIdentity({
      env,
      requireInspection: true,
      timeoutMs: 10_000,
    });
    if (owner) {
      const argv =
        owner.pid === process.pid
          ? process.argv
          : readGatewayLockProcessCmdline(owner.pid, process.platform, 10_000, undefined, env);
      const entry = classifyOpenClawArgv(argv ?? [], {
        requirePackageIdentity: true,
        pid: owner.pid,
      });
      if (entry.kind === "openclaw" && entry.packageIdentity?.root) {
        installedRoots.push(entry.packageIdentity.root);
      } else if (installedRoots.length === 0) {
        throw new UnverifiedForegroundUpdateOwnerError(owner.pid);
      }
    }
  }
  if (installedRoots.length === 0) {
    return;
  }
  const checkout = await resolveUpdateInstallationIdentity(root, env);
  for (const installedRoot of installedRoots) {
    const mismatch = await updateInstallationMismatch(checkout, installedRoot, env);
    if (mismatch) {
      throw new Error(mismatch);
    }
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
