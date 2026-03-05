import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { deliverWorkflowReport, resolveWorkflowDeliveryConfig } from "../../workflow/delivery.js";
import { formatWorkflowSummary, getWorkflowProgress } from "../../workflow/types.js";
import type { WorkflowSource, WorkflowPlan } from "../../workflow/types.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";

const WORKFLOW_ACTIONS = [
  "create",
  "list",
  "get",
  "update_task",
  "start_task",
  "complete",
  "delete",
] as const;

const WORKFLOW_SOURCES = ["heartbeat", "task", "manual", "cron"] as const;

const WORKFLOW_TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "failed",
] as const;

const WorkflowToolSchema = Type.Object({
  action: stringEnum(WORKFLOW_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  planId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  source: optionalStringEnum(WORKFLOW_SOURCES),
  tasks: Type.Optional(Type.Array(Type.Object({ content: Type.String() }))),
  taskStatus: optionalStringEnum(WORKFLOW_TASK_STATUSES),
  taskResult: Type.Optional(Type.String()),
  taskError: Type.Optional(Type.String()),
  completionStatus: optionalStringEnum(["completed", "failed"]),
  scope: optionalStringEnum(["active", "history", "all"]),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
  discordReport: Type.Optional(Type.Boolean()),
  discordChannel: Type.Optional(Type.String()),
  discordAccountId: Type.Optional(Type.String()),
});

type WorkflowToolOptions = {
  agentSessionKey?: string;
};

type GatewayToolCaller = typeof callGatewayTool;

type WorkflowToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

export function createWorkflowTool(
  opts?: WorkflowToolOptions,
  deps?: WorkflowToolDeps,
): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;

  return {
    label: "Workflow",
    name: "workflow",
    ownerOnly: false,
    description: `Manage workflow plans with task tracking for long-running operations.

ACTIONS:
- create: Create a new workflow plan with tasks
- list: List active and/or historical plans
- get: Get a specific plan's details
- update_task: Update a task's status and result
- start_task: Mark a task as in_progress
- complete: Mark a plan as completed and archive it
- delete: Delete an active plan

CREATE PARAMETERS:
- title: Plan title (required)
- description: Optional description
- source: "heartbeat" | "task" | "manual" | "cron" (default: "task")
- tasks: Array of { content: string } objects (required)

Example create:
{
  "action": "create",
  "title": "Deploy Application",
  "tasks": [
    { "content": "Build frontend" },
    { "content": "Run tests" },
    { "content": "Deploy to staging" },
    { "content": "Verify deployment" }
  ]
}

UPDATE_TASK PARAMETERS:
- planId: Plan ID (required)
- taskId: Task ID (required)
- taskStatus: "pending" | "in_progress" | "completed" | "skipped" | "failed"
- taskResult: Optional result text
- taskError: Optional error message

START_TASK PARAMETERS:
- planId: Plan ID (required)
- taskId: Task ID (required)

COMPLETE PARAMETERS:
- planId: Plan ID (required)
- completionStatus: "completed" | "failed" (default: "completed")
- discordReport: Send completion report to Discord (default: true if configured)
- discordChannel: Discord channel ID to send report
- discordAccountId: Discord account ID to use

LIST PARAMETERS:
- scope: "active" | "history" | "all" (default: "active")
- limit: Max results (default: 50)
- offset: Pagination offset

GET PARAMETERS:
- planId: Plan ID (required)
- scope: "active" | "history" (default: "active")

WORKFLOW:
1. Create plan with tasks at start of long operation
2. Use start_task before beginning each task
3. Use update_task with status="completed" after each task
4. Use complete when all tasks are done

The workflow system helps track progress and will auto-report to Discord when configured.`,
    parameters: WorkflowToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 30_000,
      };

      const cfg = loadConfig();
      const agentId = opts?.agentSessionKey
        ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
        : undefined;

      switch (action) {
        case "create": {
          const title = readStringParam(params, "title", { required: true });
          const description = readStringParam(params, "description");
          const source = (params.source as WorkflowSource) ?? "task";
          const tasks = params.tasks as Array<{ content: string }> | undefined;

          if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            throw new Error("tasks array required with at least one task");
          }

          const result = await callGateway<{ plan: unknown }>("workflow.create", gatewayOpts, {
            agentId,
            sessionKey: opts?.agentSessionKey,
            title,
            description,
            source,
            tasks,
          });

          return jsonResult({
            success: true,
            message: `Created workflow plan "${title}" with ${tasks.length} tasks`,
            plan: result.plan,
          });
        }

        case "list": {
          const scope = (params.scope as "active" | "history" | "all") ?? "active";
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 50;
          const offset =
            typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0;

          const result = await callGateway<{
            activePlans: unknown[];
            historyPlans: unknown[];
            historyTotal: number;
          }>("workflow.list", gatewayOpts, {
            agentId,
            scope,
            limit,
            offset,
          });

          return jsonResult({
            success: true,
            activePlans: result.activePlans,
            historyPlans: result.historyPlans,
            historyTotal: result.historyTotal,
          });
        }

        case "get": {
          const planId = readStringParam(params, "planId", { required: true });
          const scope = (params.scope as "active" | "history") ?? "active";

          const result = await callGateway<{ plan: unknown }>("workflow.get", gatewayOpts, {
            agentId,
            planId,
            scope,
          });

          return jsonResult({
            success: true,
            plan: result.plan,
          });
        }

        case "update_task": {
          const planId = readStringParam(params, "planId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });
          const taskStatus = params.taskStatus as string | undefined;

          if (!taskStatus) {
            throw new Error("taskStatus required for update_task action");
          }

          const result = await callGateway<{ plan: Record<string, unknown> }>(
            "workflow.task.update",
            gatewayOpts,
            {
              agentId,
              planId,
              taskId,
              status: taskStatus,
              result: params.taskResult,
              error: params.taskError,
            },
          );

          const plan = result.plan;
          const progress = getWorkflowProgress(plan as Parameters<typeof getWorkflowProgress>[0]);

          return jsonResult({
            success: true,
            message: `Task updated: ${taskStatus}`,
            progress: `${progress.completed}/${progress.total} tasks completed (${progress.percent}%)`,
            plan,
          });
        }

        case "start_task": {
          const planId = readStringParam(params, "planId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });

          const result = await callGateway<{ plan: Record<string, unknown> }>(
            "workflow.task.start",
            gatewayOpts,
            {
              agentId,
              planId,
              taskId,
            },
          );

          return jsonResult({
            success: true,
            message: "Task started",
            plan: result.plan,
          });
        }

        case "complete": {
          const planId = readStringParam(params, "planId", { required: true });
          const completionStatus =
            (params.completionStatus as "completed" | "failed") ?? "completed";
          const discordReportRequested = params.discordReport as boolean | undefined;
          const discordChannel = readStringParam(params, "discordChannel");
          const discordAccountId = readStringParam(params, "discordAccountId");

          const result = await callGateway<{ plan: Record<string, unknown> }>(
            "workflow.complete",
            gatewayOpts,
            {
              agentId,
              planId,
              status: completionStatus,
            },
          );

          const plan = result.plan as WorkflowPlan;
          const summary = formatWorkflowSummary(plan);

          // Attempt Discord delivery if requested or if auto-reporting is configured
          let discordDelivered = false;
          let discordError: string | undefined;

          // Check if we should report: explicit request, explicit channel, or configured default
          const defaultConfig = resolveWorkflowDeliveryConfig();
          const hasConfiguredChannel = defaultConfig?.enabled && !!defaultConfig?.to;
          const shouldReport =
            discordReportRequested ?? (discordChannel !== undefined || hasConfiguredChannel);

          if (shouldReport) {
            try {
              const deliveryResult = await deliverWorkflowReport({
                plan,
                channel: "discord",
                to: discordChannel,
                accountId: discordAccountId,
              });
              discordDelivered = deliveryResult.delivered;
              discordError = deliveryResult.error;
            } catch (err) {
              discordError = String(err);
            }
          }

          return jsonResult({
            success: true,
            message: `Workflow ${completionStatus}`,
            summary,
            discordReported: discordDelivered,
            discordError,
            plan,
          });
        }

        case "delete": {
          const planId = readStringParam(params, "planId", { required: true });

          await callGateway<{ deleted: boolean }>("workflow.delete", gatewayOpts, {
            agentId,
            planId,
          });

          return jsonResult({
            success: true,
            message: "Workflow plan deleted",
          });
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
