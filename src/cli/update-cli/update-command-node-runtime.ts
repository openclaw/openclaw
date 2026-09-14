// Target-aware runtime recovery; startup discovery retains its inherited-environment guards.
import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { applyPathPrepend } from "../../infra/path-prepend.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import type { PackageRuntimeRecovery } from "./update-command-node-runtime-resolution.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  resolvePackageRuntimePreflight,
  type PackageRuntimePreflight,
} from "./update-command-service-plan.js";

/** Only a live updater may provision; discovery never reads dotenv-selected paths. */
export function createPackageRuntimeRecovery(params: {
  root: string;
  opts: Pick<UpdateCommandOptions, "run" | "runtimeRecoveryEnv">;
  timeoutMs: number;
  executorFence?: UpdateRecoveryFence;
}): PackageRuntimeRecovery {
  const executor = params.opts.run?.executorFence ?? params.executorFence;
  return {
    env: params.opts.runtimeRecoveryEnv ?? {},
    ...(executor
      ? {
          installCommand: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
            executor.assertCurrent();
            const installResult = await withUpdateCommandExecutorChild(
              executor,
              params.root,
              async (_grant, beforeInput) => {
                const result = await runCommandWithTimeout([command, ...args], {
                  baseEnv: {},
                  env,
                  cwd: params.root,
                  input: "",
                  beforeInput,
                  timeoutMs: params.timeoutMs,
                  killProcessTree: true,
                  requireProcessTreeExtinction: true,
                  maxOutputBytes: 64 * 1024,
                });
                // A fulfilled runner result can still be a failed/unsettled child.
                // Fail inside its owner interval, before handoff eligibility can be used.
                if (
                  result.code !== 0 ||
                  result.termination !== "exit" ||
                  result.signal !== null ||
                  result.killed ||
                  (result.cleanup !== "normal" && result.cleanup !== "cooperative") ||
                  result.outputLimitExceeded ||
                  result.outputErrorStream
                ) {
                  throw new Error(
                    "Private Node runtime provisioning did not complete successfully.",
                  );
                }
                return result;
              },
              { auxiliaryPreflight: true },
            );
            executor.assertCurrent();
            return installResult.termination === "exit" && !installResult.killed
              ? installResult.code
              : null;
          },
        }
      : {}),
  };
}

function reportPackageRuntimeSelection(
  selection: PackageRuntimePreflight,
  opts: { json?: boolean; tag: string },
): void {
  if (!selection.replacedNodeRunner || opts.json) {
    return;
  }
  defaultRuntime.log(
    theme.warn(
      `Managed gateway service Node (${selection.replacedNodeRunner}) cannot run openclaw@${selection.targetVersion ?? opts.tag}.`,
    ),
  );
  defaultRuntime.log(
    theme.muted(
      `Using compatible Node (${selection.nodeRunner}) for the update and managed service refresh.`,
    ),
  );
}

/** The same target-runtime owner serves admitted updates and target-owned initialization. */
export async function preparePackageUpdateRuntime(params: {
  root: string;
  managedServiceRoot?: string;
  managedService?: PreManagedServiceStop;
  packageUpdateNodeRunner?: string;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageRuntimeTarget?: { version: string; nodeEngine: string | null };
  shouldRestart: boolean;
  opts: UpdateCommandOptions;
  executor: UpdateCommandExecutor;
  timeoutMs: number;
  tag: string;
}) {
  const managedServiceNodeRunner = params.managedService?.serviceNodeRunner;
  const canRefreshManagedServiceNode =
    params.shouldRestart &&
    params.managedService?.serviceUpdateVerdict?.kind === "owned" &&
    params.managedService.serviceUpdateVerdict.refreshDefinition &&
    params.managedService.serviceMutationAllowed !== false;
  const fence = await params.executor.enter(params.root, {
    preflight: true,
    serviceRoot: params.managedServiceRoot,
  });
  if (params.opts.run) {
    params.opts.run.executorFence = fence;
  }
  const result = await resolvePackageRuntimePreflight({
    target: params.packageRuntimeTarget,
    timeoutMs: params.timeoutMs,
    nodeRunner:
      params.managedServiceRoot && canRefreshManagedServiceNode
        ? params.packageUpdateNodeRunner
        : (managedServiceNodeRunner ?? params.packageUpdateNodeRunner),
    fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
    runtimeRecovery:
      !managedServiceNodeRunner || canRefreshManagedServiceNode
        ? createPackageRuntimeRecovery({
            root: params.root,
            opts: params.opts,
            timeoutMs: params.timeoutMs,
            executorFence: fence,
          })
        : undefined,
  });
  fence.assertCurrent();
  if (result.ok) {
    if (params.packageInstallEnv && result.value.nodeRunner) {
      // SAFETY: createGlobalInstallEnv filters undefined entries into a string-valued copy.
      applyPathPrepend(params.packageInstallEnv as Record<string, string>, [
        path.dirname(result.value.nodeRunner),
      ]);
    }
    reportPackageRuntimeSelection(result.value, { json: params.opts.json, tag: params.tag });
  }
  return result;
}
