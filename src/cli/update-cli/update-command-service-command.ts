import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { GatewayServiceDefinitionBackupReceiptSchema } from "../../daemon/service-stage.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  requiresRetainedUpdateCommandOwner,
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";
import type {
  OriginalManagedServiceRuntime,
  UpdateServiceDefinitionRecovery,
} from "./update-command-service-context-types.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

export const DEFINITION_DENIAL = /\bSERVICE_DEFINITION_(?:SEALED|UNKNOWN):[^\n]*/;

/** The installed CLI observed failed health after accepting activation, not a refusal. */
export class GatewayRestartHealthError extends Error {
  override name = "GatewayRestartHealthError";
}

export function isPackageManagerUpdateMode(
  mode: UpdateRunResult["mode"],
): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const error = safeParseJsonRecord(stdout)?.error;
  const diagnostics = `${stderr}\n${typeof error === "string" ? error : stdout}`;
  // Failed recovery can contain a nested writer denial; retain the outer failure.
  const detail =
    diagnostics.match(/\bUPDATE_NATIVE_AUTHORITY:[^\n]*/)?.[0] ??
    diagnostics.match(DEFINITION_DENIAL)?.[0] ??
    (typeof error === "string" ? error : stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

/** Probe the staged target before activation, retaining the original child owner. */
export async function isUpdatedInstallGatewayExecutorSupported(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  executor: UpdateRecoveryFence;
  timeoutMs: number;
  nodeRunner?: string;
  signal?: AbortSignal;
  onDefinitionBackupCapability?: (supported: boolean) => void;
  requireOriginalDefinitionBinding?: boolean;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const requiresRetainedOwner = requiresRetainedUpdateCommandOwner(params.executor);
  const entrypoint = await resolveGatewayInstallEntrypoint(params.root);
  params.executor.assertCurrent();
  if (!entrypoint) {
    return false;
  }
  const argv = [
    params.nodeRunner ?? resolveNodeRunner(),
    entrypoint,
    "gateway",
    "install",
    "--update-executor",
    "check",
    "--json",
  ];
  const check = await withUpdateCommandExecutorChild(
    params.executor,
    params.root,
    async (_grant, bindChild) => {
      const result = await runCommandWithTimeout(argv, {
        input: "",
        beforeInput: bindChild,
        baseEnv: {},
        cwd: params.root,
        env: { ...params.env, OPENCLAW_NO_RESPAWN: "1" },
        timeoutMs: params.timeoutMs,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        ...(params.signal ? { signal: params.signal } : {}),
        maxOutputBytes: 64 * 1024,
      });
      if (result.cleanup === "forced" || result.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      return result;
    },
  );
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const capability = safeParseJsonRecord(check.stdout);
  const supported =
    check.code === 0 &&
    check.termination === "exit" &&
    check.signal === null &&
    !check.killed &&
    // The child wrapper has joined the complete process tree before returning.
    // Graceful descendant settlement is not an unsupported target capability.
    (check.cleanup === "normal" || check.cleanup === "cooperative") &&
    !check.stdoutTruncatedBytes &&
    !check.outputLimitExceeded &&
    !check.outputErrorStream &&
    capability?.updateExecutor === GATEWAY_UPDATE_EXECUTOR_CONTRACT &&
    capability.targetRootBinding === true &&
    (!params.requireOriginalDefinitionBinding ||
      (capability.originalDefinitionBinding === true &&
        capability.originalRuntimePinBinding === true)) &&
    (!requiresRetainedOwner || capability.retainedOwnerBinding === true);
  params.onDefinitionBackupCapability?.(supported && capability?.definitionBackup === true);
  return supported;
}

// Loaded before package replacement: activation dependencies must stay eager.
// Candidate version/preservation guards reject older targets before repair, without retry.
export async function runUpdatedInstallGatewayCommand(
  params: {
    result: { root?: string; mode?: UpdateRunResult["mode"] };
    opts: Pick<UpdateCommandOptions, "json" | "run">;
    invocationEnv: NodeJS.ProcessEnv;
    serviceEnv?: NodeJS.ProcessEnv;
    serviceInstallEnv?: NodeJS.ProcessEnv | null;
    nodeRunner?: string;
    gatewayPort?: number;
    timeoutMs?: number;
    invocationCwd?: string;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    definitionRecovery?: UpdateServiceDefinitionRecovery;
    onWarnings?: (warnings: string[]) => void;
    onGatewayStartAttempted?: () => void;
    originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
  },
  action: "install" | "restart",
): Promise<"accepted" | "unverified"> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (params.opts.run !== run || run?.executorFence !== executor) {
      throw new Error("Native command lost its original update executor.");
    }
    executor?.assertCurrent();
    params.assertCurrent?.();
  };
  assertCurrent();
  const installing = action === "install";
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  assertCurrent();
  if (!entrypoint) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }
  const args = ["gateway", action];
  if (installing) {
    args.push("--force");
    if (params.gatewayPort !== undefined) {
      args.push("--port", String(params.gatewayPort));
    }
  } else {
    // Update retries must not bypass the installer's backup and drift audit.
    args.push("--preserve-definition");
  }
  // Capture one structured child result in both outer output modes.
  args.push("--json");
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  // The child manages this service from outside it. Captured Gateway markers
  // would misclassify recovery as an in-service restart and refuse native activation.
  const commandEnv = stripGatewayServiceMarkerEnv(
    resolveUpdatedInstallCommandEnv({
      processEnv: installing
        ? (params.serviceInstallEnv ?? params.invocationEnv)
        : params.invocationEnv,
      serviceEnv: installing ? undefined : params.serviceEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
  if (executor) {
    commandEnv.OPENCLAW_NO_RESPAWN = "1";
  }
  params.signal?.throwIfAborted();
  assertCurrent();
  const receiveInstallResult = (response: Record<string, unknown> | undefined) => {
    if (!installing || !response) {
      return;
    }
    const warnings = Array.isArray(response.warnings)
      ? response.warnings.filter((message): message is string => typeof message === "string")
      : [];
    if (warnings.length) {
      params.onWarnings?.(warnings);
    }
    if (params.definitionRecovery) {
      const backup = GatewayServiceDefinitionBackupReceiptSchema.safeParse(
        response.definitionBackup,
      );
      const error = typeof response.error === "string" ? response.error : "";
      const recoveryFailed = error.includes("UPDATE_NATIVE_AUTHORITY:");
      if (backup.success && !recoveryFailed) {
        params.definitionRecovery.backup = backup.data;
        params.definitionRecovery.unverified = false;
      } else if (!recoveryFailed && DEFINITION_DENIAL.test(error)) {
        params.definitionRecovery.preserved = true;
        params.definitionRecovery.unverified = false;
      } else {
        params.onWarnings?.([
          "Service definition backup receipt could not be verified; retained recovery data must be inspected before rollback.",
        ]);
      }
    }
  };
  const installTimeoutMs = params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS;
  if (run && !executor) {
    throw new UpdateCommandRecoveryPendingError(
      "Native command requires its original update executor.",
    );
  }
  if (executor) {
    let definitionBackupSupported = false;
    if (
      !params.result.root ||
      !(await isUpdatedInstallGatewayExecutorSupported({
        root: params.result.root,
        env: commandEnv,
        executor,
        timeoutMs: installTimeoutMs,
        nodeRunner,
        signal: params.signal,
        onDefinitionBackupCapability: (supported) => {
          definitionBackupSupported = supported;
        },
        requireOriginalDefinitionBinding:
          installing && Boolean(params.originalManagedServiceRuntime),
      }))
    ) {
      if (installing && params.originalManagedServiceRuntime) {
        throw new Error(
          "Target cannot attest the original definition rewrite; original service compensation is required.",
        );
      }
      throw new UpdateCommandRecoveryPendingError(
        "Target runtime cannot fence update-owned native commands.",
      );
    }
    assertCurrent();
    if (installing && params.definitionRecovery && !definitionBackupSupported) {
      params.definitionRecovery.preserved = true;
      const message =
        "The target installer cannot retain a service definition backup; the existing definition was preserved.";
      params.onWarnings?.([message]);
      throw new Error(`SERVICE_DEFINITION_UNKNOWN: ${message}`);
    }
  }

  if (installing && params.definitionRecovery) {
    params.definitionRecovery.unverified = true;
  }

  const runChild = async (
    grant?: UpdateCommandChildGrant,
    bindChild?: (pid: number, argv?: readonly string[]) => void,
  ) => {
    const argv = [nodeRunner, entrypoint, ...args, ...(grant ? ["--update-executor", "run"] : [])];
    params.onGatewayStartAttempted?.();
    const result = await runCommandWithTimeout(argv, {
      // The complete owned env must not regain selectors removed during capture.
      baseEnv: {},
      ...(grant
        ? {
            input: JSON.stringify({
              executor: grant,
              action,
              ...(installing && params.originalManagedServiceRuntime
                ? {
                    originalDefinition: params.originalManagedServiceRuntime.definition.fingerprint,
                    originalRuntimePin:
                      params.originalManagedServiceRuntime.definition.runtimePin.revision,
                  }
                : {}),
              targetRoot: resolveUpdateInstallRoot(params.result.root!),
            }),
            beforeInput: bindChild,
          }
        : {}),
      cwd: params.result.root,
      env: commandEnv,
      timeoutMs: installing ? installTimeoutMs : params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    });
    if (result.cleanup === "forced" || result.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    return result;
  };
  const res = executor
    ? await withUpdateCommandExecutorChild(executor, params.result.root!, runChild)
    : await runChild();
  params.signal?.throwIfAborted();
  assertCurrent();
  const exited =
    res.termination === "exit" &&
    res.signal === null &&
    !res.killed &&
    res.cleanup !== "forced" &&
    res.cleanup !== "uncertain";
  const complete = !res.stdoutTruncatedBytes && !res.outputLimitExceeded && !res.outputErrorStream;
  const response = complete ? safeParseJsonRecord(res.stdout) : undefined;
  receiveInstallResult(response);

  const original = params.originalManagedServiceRuntime;
  if (installing && original && exited && complete) {
    const receipt = asOptionalRecord(response?.rebind);
    if (
      receipt?.before === original.definition.fingerprint &&
      typeof receipt.after === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.after) &&
      receipt.runtimePinBefore === original.definition.runtimePin.revision &&
      typeof receipt.runtimePinAfter === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.runtimePinAfter)
    ) {
      // A verified no-change receipt is not a cutover. In particular, a failed
      // pre-write admission must not restart the still-healthy retained service.
      if (
        receipt.mutated === true ||
        receipt.after !== receipt.before ||
        receipt.runtimePinAfter !== receipt.runtimePinBefore
      ) {
        original.definition.rebound = receipt.after;
        original.definition.reboundRuntimePin = receipt.runtimePinAfter;
      }
    } else {
      throw new Error(
        "Native install did not return its original-definition receipt; compensation must revalidate the unchanged original.",
      );
    }
  }
  if (exited && res.code === 0) {
    return response?.action === action &&
      response.ok === true &&
      action === "restart" &&
      (response.result === "restarted" || response.result === "scheduled")
      ? "accepted"
      : "unverified";
  }
  const operation = installing ? "refresh" : action;
  const message = `updated install ${operation} failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`;
  if (
    exited &&
    res.code === 1 &&
    action === "restart" &&
    response?.action === "restart" &&
    response.ok === false &&
    response.result === "restart-health-failed" &&
    typeof response.error === "string"
  ) {
    throw new GatewayRestartHealthError(message);
  }
  if (executor && message.includes("UPDATE_NATIVE_AUTHORITY:")) {
    throw new UpdateCommandRecoveryPendingError(message);
  }
  throw new Error(message);
}

/** Await inside the admitted executor. This restarts retained A using candidate code,
 * not A's older CLI. The caller owns compatibility/identity checks and later health. */
export async function restartRetainedUpdateGatewayService(params: {
  run: NonNullable<UpdateCommandOptions["run"]>;
  root: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  onGatewayStartAttempted?: () => void;
  signal?: AbortSignal;
}): Promise<GatewayServiceRestartResult> {
  const env = { ...params.env };
  return await withRetainedUpdateServiceAuthority(params, async (assertCurrent) =>
    withGatewayServiceOperationLock(env, async (assertNative) => {
      await params.revalidate();
      assertNative();
      assertCurrent();
      return await resolveGatewayService().restart({
        stdout: params.stdout,
        env,
        beforeMutation: params.revalidate,
        onRestartAttempted: params.onGatewayStartAttempted,
        assertCurrent: () => {
          assertNative();
          assertCurrent();
        },
        preserveDefinition: true,
        preserveAutoStart: true,
      });
    }),
  );
}
