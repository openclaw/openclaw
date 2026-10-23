import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import { pinExecToolTarget } from "../agents/exec-tool-target-pinning.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseCronJobPrecheck,
  type CronJobPrecheck,
  type CronJobPrecheckResult,
  type CronJobPrecheckRunRequest,
} from "./job-precheck.js";
import type { CronStoredJob } from "./types.js";

type ExecToolResult = {
  content?: unknown;
  details?: unknown;
};

function readExecText(result: ExecToolResult): string {
  if (!Array.isArray(result.content)) {
    return "";
  }
  const first = result.content[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "";
}

function classifyExecResult(
  result: ExecToolResult,
  precheck: CronJobPrecheck,
): CronJobPrecheckResult {
  const details = isRecord(result.details) ? result.details : undefined;
  const failureKind = typeof details?.failureKind === "string" ? details.failureKind : undefined;
  if (failureKind === "approval_required" || failureKind === "auto-review-denied") {
    const text = readExecText(result).trim();
    return {
      kind: "denied",
      error: text || "exec denied: approval required",
    };
  }
  const status = typeof details?.status === "string" ? details.status : undefined;
  if (status === "running" || status === "approval-pending") {
    return { kind: "error", error: "cron precheck did not finish" };
  }
  if (status !== "completed" && status !== "failed") {
    return { kind: "error", error: "cron precheck returned no exit code" };
  }
  if (details?.timedOut === true || details?.noOutputTimedOut === true) {
    return { kind: "error", error: "cron precheck timed out" };
  }
  if (details?.exitSignal != null) {
    return { kind: "error", error: "cron precheck exited from a signal" };
  }
  const exitCode = details?.exitCode;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    return { kind: "error", error: "cron precheck returned no exit code" };
  }
  if (precheck.workExitCodes.includes(exitCode)) {
    return { kind: "work", exitCode };
  }
  if (precheck.noWorkExitCodes.includes(exitCode)) {
    return { kind: "no-work", exitCode };
  }
  return { kind: "error", error: `cron precheck exited ${exitCode}` };
}

function payloadToolsAllow(job: CronStoredJob): readonly string[] | undefined {
  const toolsAllow: unknown = job.payload.toolsAllow;
  if (toolsAllow === undefined) {
    return undefined;
  }
  if (!Array.isArray(toolsAllow) || toolsAllow.some((entry) => typeof entry !== "string")) {
    return [];
  }
  return toolsAllow;
}

/**
 * Runs a cron precheck through the exec tool. Security, ask, and allowlist
 * floors stay inside that tool; this function does not spawn a shell itself.
 */
export async function runCronJobPrecheck(
  params: CronJobPrecheckRunRequest & { config?: OpenClawConfig },
): Promise<CronJobPrecheckResult> {
  const parsed = parseCronJobPrecheck(params.job.precheck);
  if (!parsed.ok) {
    return { kind: "error", error: parsed.reason };
  }
  const toolsAllow = payloadToolsAllow(params.job);
  if (toolsAllow !== undefined && !isRuntimeToolAllowed("exec", toolsAllow)) {
    return { kind: "denied", error: "exec denied: cron toolsAllow does not include exec" };
  }
  if (params.abortSignal?.aborted) {
    return { kind: "error", error: "cron precheck aborted" };
  }
  const defaults = resolveExecToolConfig({
    cfg: params.config,
    agentId: params.job.agentId,
  });
  const execTool = createExecTool({
    ...defaults,
    agentId: params.job.agentId,
    config: params.config,
    // Headless cron must not open an approval dialog or detach past the exit code.
    nonInteractiveApproval: true,
    allowBackground: false,
    trigger: "cron",
    timeoutSec: parsed.value.timeoutSeconds,
  });
  const pin = params.job.toolsAllowExecTarget;
  if (pin && (pin.version !== 1 || pin.host !== "gateway")) {
    return { kind: "denied", error: "exec denied: cron exec target is not a gateway pin" };
  }
  // Re-check run authority immediately before the tool can spawn.
  await params.assertRunCurrent?.();
  if (params.abortSignal?.aborted) {
    return { kind: "error", error: "cron precheck aborted" };
  }
  const execArgs = {
    command: parsed.value.command,
    timeoutSeconds: parsed.value.timeoutSeconds,
  };
  try {
    const result = pin
      ? await pinExecToolTarget(execTool, {
          host: "gateway",
          ...(pin.ask ? { ask: pin.ask } : {}),
        }).execute("cron-precheck", execArgs, params.abortSignal)
      : await execTool.execute("cron-precheck", execArgs, params.abortSignal);
    return classifyExecResult(result, parsed.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "cron precheck failed";
    if (message.startsWith("exec denied:")) {
      return { kind: "denied", error: message };
    }
    return { kind: "error", error: message };
  }
}
