// Target-aware runtime recovery; startup discovery retains its inherited-environment guards.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { applyPathPrepend } from "../../infra/path-prepend.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import { prepareUpdateCommandNativeGate } from "./update-command-native-gate.js";
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
  const authority = createUpdateCommandAuthority(params, "Node runtime provisioning");
  const executor = authority.executorFence;
  return {
    env: params.opts.runtimeRecoveryEnv ?? {},
    ...(executor
      ? {
          installCommand: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
            authority.assertCurrent();
            const installResult = await withUpdateCommandExecutorChild(
              executor,
              params.root,
              async (_grant, bindChild) => {
                authority.assertRequesterCurrent();
                const gate = prepareUpdateCommandNativeGate(randomUUID(), [env]);
                const result = await runCommandWithTimeout(
                  [
                    process.execPath,
                    "--input-type=module",
                    "-e",
                    gate.source,
                    "--",
                    command,
                    ...args,
                  ],
                  {
                    baseEnv: {},
                    env: gate.env,
                    cwd: params.root,
                    input: gate.input,
                    beforeInput: (pid, argv) => {
                      authority.assertRequesterCurrent();
                      bindChild(pid, argv);
                    },
                    timeoutMs: params.timeoutMs,
                    killProcessTree: true,
                    requireProcessTreeExtinction: true,
                    maxOutputBytes: 64 * 1024,
                  },
                );
                if (result.cleanup === "forced" || result.cleanup === "uncertain") {
                  throw new CommandProcessCleanupError();
                }
                authority.assertRequesterCurrent();
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
            authority.assertCurrent();
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
  managedServiceNodeRunner?: string;
  managedService?: PreManagedServiceStop;
  packageUpdateNodeRunner?: string;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageRuntimeTarget?: { version: string; nodeEngine: string | null };
  shouldRestart: boolean;
  opts: UpdateCommandOptions;
  executor: UpdateCommandExecutor;
  timeoutMs: number;
  tag: string;
  invocationCwd?: string;
  channel?: import("../../infra/update-channels.js").UpdateChannel;
  requestedChannel?: import("../../infra/update-channels.js").UpdateChannel | null;
}) {
  // Discovery can retain the service runner before schema inspection has a service context.
  // Its absence there must not turn a no-restart or foreign service into a provisionable runtime.
  const managedServiceNodeRunner =
    params.managedService?.serviceNodeRunner ?? params.managedServiceNodeRunner;
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
    root: params.root,
    service: params.managedService,
    shouldRestart: params.shouldRestart,
    invocationCwd: params.invocationCwd,
    channel: params.channel,
    requestedChannel: params.requestedChannel,
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
