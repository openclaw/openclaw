/**
 * Orchestration tool: allows agents to spawn multi-step parallel workflows.
 *
 * Exposes the Perplexity Computer-style task decomposition + sub-agent
 * orchestration system as an agent-callable tool.
 *
 * Actions:
 *   - preview: Show what tasks would be created for a goal (no execution)
 *   - run: Execute the full orchestrated workflow
 */

import { Type } from "@sinclair/typebox";
import { orchestrate, previewPlan } from "../../acp/orchestrator.js";
import { routeTask } from "../../routing/model-router.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ORCHESTRATION_ACTIONS = ["preview", "run", "route"] as const;

const OrchestrationToolSchema = Type.Object({
  action: optionalStringEnum(ORCHESTRATION_ACTIONS),
  /** High-level goal to decompose and execute */
  goal: Type.Optional(Type.String()),
  /** For action=route: the task text to classify and route */
  task: Type.Optional(Type.String()),
  /** Latency budget hint */
  latencyBudget: optionalStringEnum(["fast", "normal", "thorough"]),
  /** Max parallel sub-agents */
  maxConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  /** Override merge strategy */
  mergeStrategy: optionalStringEnum(["sequential", "summary", "code", "report"]),
});

type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];

export function createOrchestrationTool(): AnyAgentTool {
  return {
    label: "Orchestration",
    name: "orchestration",
    description:
      "Decompose a complex goal into parallel sub-agent tasks and execute them. " +
      "Use action=preview to see the task plan without running it, " +
      "action=run to execute the full orchestrated workflow, " +
      "or action=route to classify a task and see which model would handle it.",
    parameters: OrchestrationToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "preview") as OrchestrationAction;

      if (action === "route") {
        const task = readStringParam(params, "task", { required: true });
        const latencyBudget =
          (readStringParam(params, "latencyBudget") as "fast" | "normal" | "thorough") ?? "normal";
        const decision = routeTask(task, { latencyBudget });
        return jsonResult({
          status: "ok",
          action: "route",
          task_type: decision.taskType,
          provider: decision.provider,
          model: decision.model,
          confidence: decision.confidence,
          reason: decision.reason,
        });
      }

      const goal = readStringParam(params, "goal", { required: true });

      if (action === "preview") {
        const preview = previewPlan(goal);
        return jsonResult({
          status: "ok",
          action: "preview",
          goal,
          plan_preview: preview,
        });
      }

      if (action === "run") {
        const latencyBudget =
          (readStringParam(params, "latencyBudget") as "fast" | "normal" | "thorough") ?? "normal";
        const maxConcurrencyRaw =
          typeof params.maxConcurrency === "number" ? params.maxConcurrency : undefined;
        const maxConcurrency = maxConcurrencyRaw
          ? Math.max(1, Math.min(10, Math.floor(maxConcurrencyRaw)))
          : 5;
        const mergeStrategy = readStringParam(params, "mergeStrategy") as
          | "sequential"
          | "summary"
          | "code"
          | "report"
          | undefined;

        const progressUpdates: string[] = [];

        const result = await orchestrate(goal, {
          maxConcurrency,
          mergeStrategy: mergeStrategy ?? undefined,
          routerOptions: { latencyBudget },
          onProgress: (progress) => {
            progressUpdates.push(progress);
          },
        });

        const { taskSummaries, failedTasks } = result.merged;
        const succeeded = taskSummaries.filter((t) => t.status === "done").length;
        const total = taskSummaries.length;

        return jsonResult({
          status: failedTasks.length === 0 ? "ok" : "partial",
          action: "run",
          goal,
          plan_id: result.plan.id,
          tasks_total: total,
          tasks_succeeded: succeeded,
          tasks_failed: failedTasks,
          merge_strategy: result.merged.strategy,
          output: result.merged.output,
          task_summaries: taskSummaries,
        });
      }

      return jsonResult({ status: "error", error: "Unknown action." });
    },
  };
}
