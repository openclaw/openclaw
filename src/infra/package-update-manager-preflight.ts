import fs from "node:fs/promises";
import path from "node:path";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { UPDATE_GLOBAL_PERMISSION_REASON } from "../shared/update-outcome.js";
import { hasErrnoCode, isErrno } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import {
  listActivePnpmIsolatedGlobalPackages,
  resolvePnpmIsolatedInstallOwner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  readPackageManagerProbeValue,
} from "./update-npm-prefix.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export async function resolveCanonicalPath(filePath: string): Promise<string> {
  return path.resolve(await fs.realpath(filePath).catch(() => filePath));
}

export async function runPnpmPreflightProbe(params: {
  installTarget: ResolvedGlobalInstallTarget;
  args: string[];
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  name?: string;
  cwd?: string;
}): Promise<{
  result: Awaited<ReturnType<CommandRunner>> | null;
  failedStep: UpdateStepResult | null;
}> {
  const startedAt = Date.now();
  const argv = [params.installTarget.command, ...params.args];
  const probeCwd = params.cwd ?? params.installTarget.globalRoot ?? undefined;
  // pnpm reads project packageManager/config for every command. Keep all
  // ownership probes in one manager-owned context before mutation.
  const result = await params
    .runCommand(argv, {
      timeoutMs: params.timeoutMs,
      env: params.env,
      ...(probeCwd ? { cwd: probeCwd } : {}),
    })
    .catch((error: unknown) => ({ stdout: "", stderr: formatErrorMessage(error), code: 1 }));
  return result.code === 0
    ? { result, failedStep: null }
    : {
        result: null,
        failedStep: {
          name: params.name ?? "pnpm isolated install preflight",
          command: argv.join(" "),
          cwd: probeCwd ?? process.cwd(),
          durationMs: Date.now() - startedAt,
          exitCode: result.code ?? 1,
          stdoutTail: result.stdout || null,
          stderrTail: result.stderr || `Unable to run ${argv.join(" ")}.`,
        },
      };
}

export async function validatePnpmIsolatedUpdate(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  globalBinDir: string | null;
  failedStep: UpdateStepResult | null;
}> {
  const owner = params.installTarget.pnpmIsolated;
  if (!owner) {
    return { globalBinDir: null, failedStep: null };
  }
  const activePackages = await listActivePnpmIsolatedGlobalPackages({
    globalRoot: params.installTarget.globalRoot,
    packageName: params.packageName,
  });
  const activePackageRoots = activePackages.map((entry) => entry.packageRoot);
  const siblingPackages = [
    ...new Set(
      activePackages.flatMap((entry) =>
        entry.packageNames.filter((name) => name !== params.packageName),
      ),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
  if (siblingPackages.length > 0) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `inspect ${params.installTarget.globalRoot ?? "pnpm install"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: `OpenClaw shares a pnpm ${owner.layoutVersion} global install group with ${siblingPackages.join(", ")}. Automatic update stopped before mutation; update the group manually to preserve its sibling packages.`,
      },
    };
  }

  const invokingPackageRoot = params.installTarget.packageRoot;
  const invokingInstallOwner = await resolvePnpmIsolatedInstallOwner(invokingPackageRoot);
  const activeInstallOwners = await Promise.all(
    activePackageRoots.map((packageRoot) => resolvePnpmIsolatedInstallOwner(packageRoot)),
  );
  const ownerMatchCount = invokingInstallOwner
    ? activeInstallOwners.filter((installOwner) => installOwner === invokingInstallOwner).length
    : 0;
  if (!invokingPackageRoot || activePackageRoots.length !== 1 || ownerMatchCount !== 1) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `inspect ${params.installTarget.globalRoot ?? "pnpm install"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: `Expected exactly one active pnpm ${owner.layoutVersion} OpenClaw install owned by the invoking project; found ${activePackageRoots.length} active installs and ${ownerMatchCount} owner matches. Automatic update stopped before mutation.`,
      },
    };
  }

  const rootProbe = await runPnpmPreflightProbe({ ...params, args: ["root", "-g"] });
  if (rootProbe.failedStep || !rootProbe.result) {
    return {
      globalBinDir: null,
      failedStep: rootProbe.failedStep,
    };
  }
  const reportedGlobalRoot = readPackageManagerProbeValue(rootProbe.result.stdout);
  const expectedGlobalRoot = params.installTarget.globalRoot;
  if (
    !reportedGlobalRoot ||
    !expectedGlobalRoot ||
    (await resolveCanonicalPath(reportedGlobalRoot)) !==
      (await resolveCanonicalPath(expectedGlobalRoot))
  ) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `${params.installTarget.command} root -g`,
        cwd: expectedGlobalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: rootProbe.result.stdout || null,
        stderrTail: `The active pnpm command owns ${reportedGlobalRoot || "an unknown global root"}, not the invoking OpenClaw install at ${expectedGlobalRoot ?? "an unknown root"}. Automatic update stopped before mutation.`,
      },
    };
  }

  const binProbe = await runPnpmPreflightProbe({ ...params, args: ["bin", "-g"] });
  const globalBinDir = binProbe.result
    ? readPackageManagerProbeValue(binProbe.result.stdout) || null
    : null;
  if (binProbe.failedStep || !globalBinDir) {
    return {
      globalBinDir: null,
      failedStep: binProbe.failedStep ?? {
        name: "pnpm isolated install preflight",
        command: `${params.installTarget.command} bin -g`,
        cwd: expectedGlobalRoot,
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: "The owning pnpm command did not report its global bin directory.",
      },
    };
  }

  // The CLI major is independent of the global layout (pnpm 12 still uses v11).
  // Ownership is established by the active project, reported root, and bin above.
  return {
    globalBinDir,
    failedStep: null,
  };
}

async function existingDirectory(target: string): Promise<string> {
  let directory = path.resolve(target);
  while (true) {
    try {
      if ((await fs.stat(directory)).isDirectory()) {
        return directory;
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return directory;
    }
    directory = parent;
  }
}

async function permissionFailure(
  step: UpdateStepResult,
  directory: string,
  code: string,
  env?: NodeJS.ProcessEnv,
): Promise<UpdateStepResult> {
  const stat = await fs.stat(directory).catch(() => null);
  const owner =
    process.platform === "win32" || !stat
      ? "owner unavailable"
      : `owner UID ${stat.uid}${stat.uid === 0 ? " (root)" : ""}, GID ${stat.gid}`;
  const repair =
    process.platform !== "win32" && stat && stat.uid === process.getuid?.()
      ? `Run \`chmod u+rwx ${quoteCliArg(directory)}\`, then rerun \`openclaw update\`.`
      : "Run the package update as the directory's owning account, keeping the Gateway's existing state/configuration; or ask that account to grant you write access, then rerun `openclaw update`.";
  const message = `Package update cannot write ${directory} (${code}; ${owner}). ${repair}`;
  return {
    ...step,
    stderrTail: message,
    failureFacts: [
      createUpdateFailureFact(
        { check: "package-install", code: UPDATE_GLOBAL_PERMISSION_REASON, message },
        env,
      ),
    ],
  };
}

/** Inspect the directories npm staging and launcher publication must write, without creating a probe. */
export async function checkGlobalPackageUpdatePermissions(
  target: ResolvedGlobalInstallTarget,
  env?: NodeJS.ProcessEnv,
): Promise<UpdateStepResult | null> {
  if (target.manager !== "npm" || !target.globalRoot) {
    return null;
  }
  const layout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(target.globalRoot, {
    allowDirectNodeModulesRoot: target.directNodeModulesRoot === true,
  });
  for (const candidate of new Set([target.globalRoot, ...(layout ? [layout.binDir] : [])])) {
    const directory = await existingDirectory(candidate);
    try {
      await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK);
    } catch (error) {
      if (hasErrnoCode(error, "EACCES") || hasErrnoCode(error, "EPERM")) {
        return await permissionFailure(
          {
            name: "global install permissions",
            command: "inspect npm global directories",
            cwd: directory,
            durationMs: 0,
            exitCode: 1,
          },
          directory,
          hasErrnoCode(error, "EACCES") ? "EACCES" : "EPERM",
          env,
        );
      }
      // An unavailable inspection is not proof of a permission failure. The
      // install boundary still classifies an actual denial after this read.
    }
  }
  return null;
}

/** Keep real install/staging errors actionable even when permissions change after admission. */
export async function classifyPackageUpdatePermissionFailure(
  step: UpdateStepResult,
  target: ResolvedGlobalInstallTarget,
  env?: NodeJS.ProcessEnv,
  error?: unknown,
): Promise<UpdateStepResult> {
  const text = step.stderrTail ?? "";
  const code = isErrno(error) ? error.code : text.match(/\b(EACCES|EPERM)\b/u)?.[1];
  if (step.exitCode === 0 || (code !== "EACCES" && code !== "EPERM")) {
    return step;
  }
  const reportedPath =
    (isErrno(error) ? error.path : undefined) ??
    text.match(/(?:^|\n)npm (?:ERR!|error) path (.+)/u)?.[1] ??
    text.match(/(?:mkdir|mkdtemp|rename|unlink|open|scandir) '([^']+)'/u)?.[1];
  const targetPath =
    reportedPath && path.isAbsolute(reportedPath) ? reportedPath : target.globalRoot;
  if (!targetPath) {
    return step;
  }
  // Rename/unlink require the parent directory even when the package itself exists.
  const directory = await existingDirectory(
    reportedPath && /\b(rename|unlink)\b/u.test(text) ? path.dirname(targetPath) : targetPath,
  );
  return await permissionFailure(step, directory, code, env);
}
