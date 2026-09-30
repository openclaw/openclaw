import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { scriptFailure } from "./trigger-script-result.js";
import type { createCronCodeModeRunner } from "./trigger-script.js";
import type { CronTriggerEvaluationResult, CronTriggerFailureCode } from "./types.js";

export type HeartbeatContextCommandOutput = { command: string; output: string };

export type HeartbeatContextCollection = {
  agentId: string;
  monitorJobId: string;
  sessionKey: string;
  commands: string[];
  /** Captured by the server from the registering agent's final tool surface. */
  authority: { toolsAllow: string[]; scheduledToolPolicy: ScheduledToolPolicyContext };
  abortSignal: AbortSignal;
  isCurrent: () => boolean;
  /** Epoch deadline for this group's collection; never extends the 30-second cap. */
  deadlineMs?: number;
};

/** Collects bounded heartbeat evidence through the admitted cron runner. */
export function createHeartbeatContextCollector(run: ReturnType<typeof createCronCodeModeRunner>) {
  return async (
    params: HeartbeatContextCollection,
  ): Promise<
    | { kind: "collected"; outputs: HeartbeatContextCommandOutput[] }
    | { kind: "error"; code: CronTriggerFailureCode; error: string }
  > => {
    if (
      params.commands.length < 1 ||
      params.commands.length > 5 ||
      params.commands.some((command) => !command.trim()) ||
      !params.authority.toolsAllow.includes("exec")
    ) {
      return scriptFailure(
        "Heartbeat context commands require a captured exec grant and 1–5 commands.",
      );
    }
    const remainingMs = (params.deadlineMs ?? Number.POSITIVE_INFINITY) - Date.now();
    const outputs: HeartbeatContextCommandOutput[] = [];
    let collectionFailure: Extract<CronTriggerEvaluationResult, { kind: "error" }> | undefined;
    function failCollection(error: string, code: CronTriggerFailureCode = "internal_error"): never {
      collectionFailure = scriptFailure(error, code);
      throw new Error(error);
    }
    const outcome = await run({
      jobId: params.monitorJobId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      toolsAllow: ["exec"],
      scheduledToolPolicy: params.authority.scheduledToolPolicy,
      heartbeatCollector: true,
      script: `for (const command of ${JSON.stringify(params.commands)}) { await exec({ command, timeoutSeconds: 25, background: false }); }`,
      state: null,
      abortSignal: params.abortSignal,
      isCurrent: params.isCurrent,
      wallClockMs: Math.max(1, Math.min(30_000, remainingMs)),
      maxToolCalls: params.commands.length,
      label: "heartbeat context collection",
      collectOutput: (input, result) => {
        const details = isRecord(result) ? result.details : undefined;
        if (
          !isRecord(input) ||
          typeof input.command !== "string" ||
          !isRecord(details) ||
          details.status !== "completed" ||
          details.exitCode !== 0 ||
          typeof details.aggregated !== "string"
        ) {
          failCollection(
            "Heartbeat context command failed or requires approval; inspect the group's commands.",
          );
        }
        if (details.truncated !== false) {
          failCollection(
            "Heartbeat context output is incomplete; narrow or split the commands.",
            "output_limit_exceeded",
          );
        }
        outputs.push({ command: input.command, output: details.aggregated });
        if (Buffer.byteLength(JSON.stringify(outputs), "utf8") > 16 * 1024) {
          failCollection(
            "Heartbeat context output exceeds 16 KiB; narrow or split the commands.",
            "output_limit_exceeded",
          );
        }
      },
    });
    if (collectionFailure) {
      return collectionFailure;
    }
    if (outcome.kind === "error") {
      // Tool/provider errors can include command text or output; only the failure class leaves this collector.
      return scriptFailure(`Heartbeat context collection failed (${outcome.code}).`, outcome.code);
    }
    return outputs.length === params.commands.length
      ? { kind: "collected", outputs }
      : scriptFailure("Heartbeat context collection returned incomplete command results.");
  };
}
