/** Model actions bound to one admitted automation invocation. */
import { parseDurationMs } from "../../cli/parse-duration.js";
import {
  createAutomationResultRecorder,
  createAutomationRunGuard,
  recordCronNextCheckProposal,
} from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { jsonResult, readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import type { CronToolOptions } from "./cron-tool.types.js";
import type { callGatewayTool, GatewayCallOptions } from "./gateway.js";

export function createCronAutomationActions(opts?: CronToolOptions) {
  const selfJobId = opts?.selfRemoveOnlyJobId?.trim();
  const automationRun =
    opts?.runId && selfJobId
      ? getAgentRunContext(opts.runId)?.cronRunsByJobId?.get(selfJobId)
      : undefined;
  const activeRun = Boolean(automationRun?.assertCurrent && !automationRun.closed);
  const assertCurrentRun =
    opts?.runId && selfJobId && automationRun
      ? createAutomationRunGuard(opts.runId, selfJobId)
      : undefined;
  const nextCheckEnabled = Boolean(activeRun && automationRun?.nextCheckEnabled);
  const recordResult =
    opts?.runId && selfJobId && activeRun
      ? createAutomationResultRecorder(opts.runId, selfJobId)
      : undefined;
  return {
    activeRun,
    nextCheckEnabled,
    assertCurrent: assertCurrentRun,
    execute: async (
      action: string,
      params: Record<string, unknown>,
      callGateway: typeof callGatewayTool,
      gatewayOpts: GatewayCallOptions,
    ) => {
      assertCurrentRun?.();
      switch (action) {
        case "scratch_get":
        case "scratch_set": {
          if (!selfJobId || !activeRun || !assertCurrentRun) {
            throw new Error(
              "scratch actions are only available inside the currently running automation; use the automation editor for other jobs",
            );
          }
          if (action === "scratch_get") {
            return jsonResult(
              await callGateway("cron.scratch.get", gatewayOpts, { id: selfJobId }),
            );
          }
          if (typeof params.content !== "string" && params.content !== null) {
            throw new Error("scratch_set requires complete content or null to clear");
          }
          const expectedRevision = readNonNegativeIntegerParam(params, "expectedRevision");
          if (expectedRevision === undefined) {
            throw new Error("scratch_set requires expectedRevision from scratch_get");
          }
          return jsonResult(
            await callGateway("cron.scratch.set", gatewayOpts, {
              id: selfJobId,
              content: params.content,
              expectedRevision,
            }),
          );
        }
        case "record_result": {
          if (!selfJobId || !recordResult) {
            throw new Error(
              "record_result is only available inside the currently running automation",
            );
          }
          const outcome = params.outcome;
          const result = recordResult({
            outcome,
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
          });
          return jsonResult({ ok: true, ...result });
        }
        case "next_check": {
          const jobId = selfJobId;
          const runId = opts?.runId?.trim();
          if (!jobId || !runId || !activeRun || !assertCurrentRun) {
            throw new Error("cron next_check is only available to the currently running job");
          }
          const rawDuration = readToolStringParam(params, "in", { required: true });
          let delayMs: number;
          try {
            delayMs = parseDurationMs(rawDuration);
          } catch {
            throw new Error("cron next_check in must be a positive duration");
          }
          if (delayMs <= 0) {
            throw new Error("cron next_check in must be a positive duration");
          }
          recordCronNextCheckProposal(runId, jobId, delayMs);
          return jsonResult({ ok: true, delayMs });
        }
        default:
          throw new Error(`Unknown automation invocation action: ${action}`);
      }
    },
  };
}
