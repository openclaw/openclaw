/** Builds one self-contained, launch-verified package artifact before a global update mutates it. */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { formatErrorMessage } from "./errors.js";
import { collectInstalledGlobalPackageErrors, type CommandRunner } from "./update-global.js";
import { readUpdateRollbackTransaction } from "./update-rollback.js";

const RETAINED_UPDATE_PACKAGE_DIRNAME = ".openclaw-previous";

type RetainedUpdatePackageResult = {
  retainedRoot: string | null;
  step: {
    name: string;
    command: string;
    cwd: string;
    durationMs: number;
    exitCode: number;
    stdoutTail: string | null;
    stderrTail: string | null;
  };
};

async function removeTree(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

/** Retain the current package beside its manager root, replacing only the older retained copy. */
export async function retainCurrentPackageForUpdate(params: {
  packageRoot: string;
  globalRoot: string | null;
  expectedVersion: string | null;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  transactionEnv?: NodeJS.ProcessEnv;
}): Promise<RetainedUpdatePackageResult> {
  const startedAt = Date.now();
  const ownerRoot = path.resolve(params.globalRoot ?? path.dirname(params.packageRoot));
  const retentionParent = path.dirname(ownerRoot);
  const retainedRoot = path.join(retentionParent, RETAINED_UPDATE_PACKAGE_DIRNAME);
  const stagedRoot = `${retainedRoot}.stage-${process.pid}-${Date.now()}`;
  const command = `retain ${params.packageRoot} -> ${retainedRoot}`;
  try {
    const activeTransaction = await readUpdateRollbackTransaction(
      params.transactionEnv ?? params.env ?? process.env,
    );
    if (activeTransaction?.state === "pending") {
      throw new Error(
        `an update rollback transaction is already pending for ${activeTransaction.newVersion}`,
      );
    }
    await fs.mkdir(retentionParent, { recursive: true });
    await removeTree(stagedRoot);
    await fs.cp(params.packageRoot, stagedRoot, {
      recursive: true,
      dereference: true,
      force: true,
      preserveTimestamps: true,
    });
    const packageErrors = await collectInstalledGlobalPackageErrors({
      packageRoot: stagedRoot,
      expectedVersion: params.expectedVersion,
    });
    const entrypoint = await resolveGatewayInstallEntrypoint(stagedRoot);
    if (!entrypoint) {
      packageErrors.push("retained package has no launchable entrypoint");
    } else {
      const probe = await params.runCommand([process.execPath, entrypoint, "--version"], {
        cwd: stagedRoot,
        timeoutMs: params.timeoutMs,
        env: params.env,
      });
      if (probe.code !== 0) {
        packageErrors.push(
          `retained package launch probe failed: ${probe.stderr.trim() || probe.stdout.trim() || `exit ${probe.code ?? 1}`}`,
        );
      }
    }
    if (packageErrors.length > 0) {
      await removeTree(stagedRoot);
      return {
        retainedRoot: null,
        step: {
          name: "retain previous package",
          command,
          cwd: retentionParent,
          durationMs: Date.now() - startedAt,
          exitCode: 1,
          stdoutTail: null,
          stderrTail: packageErrors.join("\n"),
        },
      };
    }
    await removeTree(retainedRoot);
    await fs.rename(stagedRoot, retainedRoot);
    return {
      retainedRoot,
      step: {
        name: "retain previous package",
        command,
        cwd: retentionParent,
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        stdoutTail: `retained one launchable previous package at ${retainedRoot}`,
        stderrTail: null,
      },
    };
  } catch (error) {
    await removeTree(stagedRoot).catch(() => undefined);
    return {
      retainedRoot: null,
      step: {
        name: "retain previous package",
        command,
        cwd: retentionParent,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(error),
      },
    };
  }
}
