import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
export const DEFINITION_DENIAL = /\bSERVICE_DEFINITION_(?:SEALED|UNKNOWN):[^\n]*/;

/** The installed CLI observed failed health after accepting activation, not a refusal. */
export class GatewayRestartHealthError extends Error {
  override name = "GatewayRestartHealthError";
}

function formatCommandFailure(stdout: string, stderr: string): string {
  // Keep the stable denial even when JSON stdout accompanies unrelated stderr warnings.
  const error = safeParseJsonRecord(stdout)?.error;
  const detail =
    `${stderr}\n${stdout}`.match(DEFINITION_DENIAL)?.[0] ??
    (typeof error === "string" ? error : stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

// Use the candidate's version guards for both refresh and activation. The parsed
// preservation option makes older targets reject before repair, without a retry.
export async function runUpdatedInstallGatewayCommand(
  params: {
    result: { root?: string; mode?: UpdateRunResult["mode"] };
    opts: Pick<UpdateCommandOptions, "json">;
    invocationEnv: NodeJS.ProcessEnv;
    serviceEnv?: NodeJS.ProcessEnv;
    serviceInstallEnv?: NodeJS.ProcessEnv | null;
    nodeRunner?: string;
    timeoutMs?: number;
    invocationCwd?: string;
  },
  action: "install" | "restart",
  preserveDefinition = false,
): Promise<"accepted" | "unverified"> {
  const installing = action === "install";
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    if (installing) {
      const { isPackageManagerUpdateMode } = await import("./update-command-service-recovery.js");
      if (!isPackageManagerUpdateMode(params.result.mode ?? "unknown")) {
        const { runDaemonInstall } = await import("../daemon-cli/install.runtime.js");
        await runDaemonInstall({ force: true, json: params.opts.json || undefined });
        return "unverified";
      }
    }
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
  const nodeRunner = params.nodeRunner ?? (await import("./shared.js")).resolveNodeRunner();
  const res = await runCommandWithTimeout([nodeRunner, entrypoint, ...args], {
    // The complete owned env must not regain selectors removed during capture.
    baseEnv: {},
    cwd: params.result.root,
    env: resolveUpdatedInstallCommandEnv({
      processEnv: installing
        ? (params.serviceInstallEnv ?? params.invocationEnv)
        : params.invocationEnv,
      serviceEnv: installing ? undefined : params.serviceEnv,
      invocationCwd: params.invocationCwd,
    }),
    // Restart owns migration-aware readiness; only refresh has the fixed watchdog.
    timeoutMs: installing ? SERVICE_REFRESH_TIMEOUT_MS : params.timeoutMs,
  });
  const exited =
    res.termination === "exit" &&
    res.signal === null &&
    !res.killed &&
    res.cleanup !== "forced" &&
    res.cleanup !== "uncertain";
  const complete = !res.stdoutTruncatedBytes && !res.outputLimitExceeded && !res.outputErrorStream;
  const response = complete ? safeParseJsonRecord(res.stdout) : undefined;
  if (exited && res.code === 0) {
    return action === "restart" &&
      response?.action === "restart" &&
      response.ok === true &&
      (response.result === "restarted" || response.result === "scheduled")
      ? "accepted"
      : "unverified";
  }
  const operation = installing ? "refresh" : "restart";
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
  throw new Error(message);
}
