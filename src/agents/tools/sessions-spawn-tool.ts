import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  // Structured task specification fields (optional, for better subagent handoffs)
  objective: Type.Optional(Type.String({ description: "One-sentence objective for the subagent" })),
  successCriteria: Type.Optional(
    Type.Array(Type.String(), { description: "Verifiable conditions that define success" }),
  ),
  expectedOutputs: Type.Optional(
    Type.Array(Type.String(), { description: "Expected output artifacts (e.g. file paths)" }),
  ),
  constraints: Type.Optional(
    Type.Array(Type.String(), { description: "Constraints the subagent must respect" }),
  ),
  reportBack: Type.Optional(
    Type.Boolean({ description: "Whether the subagent should report results back" }),
  ),
});

function buildTaskSpec(params: {
  task: string;
  objective?: string;
  successCriteria?: string[];
  expectedOutputs?: string[];
  constraints?: string[];
  reportBack?: boolean;
}): string {
  const lines: string[] = ["[TASK_SPEC]"];
  if (params.objective) {
    lines.push(`Objective: ${params.objective}`);
  }
  lines.push("");
  lines.push("Task:");
  lines.push(params.task);
  if (params.successCriteria?.length) {
    lines.push("");
    lines.push("Success criteria:");
    for (const criterion of params.successCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
  }
  if (params.expectedOutputs?.length) {
    lines.push("");
    lines.push("Expected outputs:");
    for (const output of params.expectedOutputs) {
      lines.push(`- ${output}`);
    }
  }
  if (params.constraints?.length) {
    lines.push("");
    lines.push("Constraints:");
    for (const constraint of params.constraints) {
      lines.push(`- ${constraint}`);
    }
  }
  if (params.reportBack !== false) {
    lines.push("");
    lines.push(
      "When done, report your results including evidence of each success criterion being met.",
    );
  }
  lines.push("[/TASK_SPEC]");
  return lines.join("\n");
}
export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawTask = readStringParam(params, "task", { required: true });
      const objective = readStringParam(params, "objective");
      const successCriteria = Array.isArray(params.successCriteria)
        ? (params.successCriteria as string[]).filter((s) => typeof s === "string" && s.trim())
        : undefined;
      const expectedOutputs = Array.isArray(params.expectedOutputs)
        ? (params.expectedOutputs as string[]).filter((s) => typeof s === "string" && s.trim())
        : undefined;
      const constraints = Array.isArray(params.constraints)
        ? (params.constraints as string[]).filter((s) => typeof s === "string" && s.trim())
        : undefined;
      const reportBack = typeof params.reportBack === "boolean" ? params.reportBack : undefined;
      const hasStructuredFields = Boolean(
        objective || successCriteria?.length || expectedOutputs?.length || constraints?.length,
      );
      const task = hasStructuredFields
        ? buildTaskSpec({
            task: rawTask,
            objective,
            successCriteria,
            expectedOutputs,
            constraints,
            reportBack,
          })
        : rawTask;
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          cleanup,
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      return jsonResult(result);
    },
  };
}
