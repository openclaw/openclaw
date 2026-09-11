import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { retireCommandProcessJobForHandoff } from "../../process/exec-spawn.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import {
  runGatewayInstallWithLoadBoundary,
  type UpdateServiceLoadBoundary,
} from "./update-command-service-load.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
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
  // Keep the stable denial even when JSON stdout accompanies unrelated stderr warnings.
  const error = safeParseJsonRecord(stdout)?.error;
  const detail =
    `${stderr}\n${stdout}`.match(DEFINITION_DENIAL)?.[0] ??
    (typeof error === "string" ? error : stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

/** Probe the staged target before activation, retaining the original child owner. */
export async function isUpdatedInstallGatewayExecutorSupported(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  executor: UpdateRecoveryFence;
  nodeRunner?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const entrypoint = await resolveGatewayInstallEntrypoint(params.root);
  params.executor.assertCurrent();
  if (!entrypoint) {
    return false;
  }
  const check = await withUpdateCommandExecutorChild(
    params.executor,
    params.root,
    (_grant, beforeInput) =>
      runCommandWithTimeout(
        [
          params.nodeRunner ?? resolveNodeRunner(),
          entrypoint,
          "gateway",
          "install",
          "--update-executor",
          "check",
        ],
        {
          input: "",
          beforeInput,
          baseEnv: {},
          cwd: params.root,
          env: { ...params.env, OPENCLAW_NO_RESPAWN: "1" },
          timeoutMs: 30_000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          ...(params.signal ? { signal: params.signal } : {}),
          maxOutputBytes: 64 * 1024,
        },
      ),
  );
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const capability = safeParseJsonRecord(check.stdout);
  return (
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
    capability.targetRootBinding === true
  );
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
    timeoutMs?: number;
    invocationCwd?: string;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    serviceLoadBoundary?: UpdateServiceLoadBoundary;
  },
  action: "install" | "restart",
  preserveDefinition = false,
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
  if (action !== "stop") {
    await retireCommandProcessJobForHandoff();
    assertCurrent();
  }
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
  } else if (preserveDefinition) {
    args.push("--preserve-definition");
  }
  // Capture one structured child result in both outer output modes.
  args.push("--json");
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  const commandEnv = resolveUpdatedInstallCommandEnv({
    processEnv: installing
      ? (params.serviceInstallEnv ?? params.invocationEnv)
      : params.invocationEnv,
    serviceEnv: installing ? undefined : params.serviceEnv,
    invocationCwd: params.invocationCwd,
  });
  if (executor) {
    commandEnv.OPENCLAW_NO_RESPAWN = "1";
  }
  params.signal?.throwIfAborted();
  assertCurrent();
  const boundary = params.serviceLoadBoundary;
  if (installing && boundary) {
    return await runGatewayInstallWithLoadBoundary({
      argv: [nodeRunner, entrypoint, ...args, "--defer-activation"],
      cwd: params.result.root,
      env: commandEnv,
      signal: params.signal,
      boundary: {
        ...boundary,
        // The handoff adds an executor fence; it must not replace the repair owner.
        assertCurrent: () => {
          assertCurrent();
          boundary.assertCurrent();
        },
      },
    });
  }
  if (run && !executor) {
    throw new UpdateCommandRecoveryPendingError(
      "Native command requires its original update executor.",
    );
  }
  if (executor) {
    if (
      !params.result.root ||
      !(await isUpdatedInstallGatewayExecutorSupported({
        root: params.result.root,
        env: commandEnv,
        executor,
        nodeRunner,
        signal: params.signal,
      }))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Target runtime cannot fence update-owned native commands.",
      );
    }
    assertCurrent();
  }

  const runChild = (grant?: UpdateCommandChildGrant, beforeInput?: (pid: number) => void) =>
    runCommandWithTimeout(
      [nodeRunner, entrypoint, ...args, ...(grant ? ["--update-executor", "run"] : [])],
      {
        // The complete owned env must not regain selectors removed during capture.
        baseEnv: {},
        ...(grant
          ? {
              input: JSON.stringify({
                executor: grant,
                action,
                targetRoot: resolveUpdateInstallRoot(params.result.root!),
              }),
              beforeInput,
            }
          : {}),
        cwd: params.result.root,
        env: commandEnv,
        // Restart owns migration-aware readiness; only refresh has the fixed watchdog.
        timeoutMs: installing ? SERVICE_REFRESH_TIMEOUT_MS : params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    );
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
