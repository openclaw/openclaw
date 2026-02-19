import { Type } from "@sinclair/typebox";
import type { Workflow } from "../../enterprise/types.js";
import { ApprovalGates } from "../../enterprise/approval-gates.js";
import { WorkflowOrchestrator } from "../../enterprise/workflow-orchestrator.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// Singleton instance for state persistence
let orchestratorInstance: WorkflowOrchestrator | null = null;

function getOrchestrator(): WorkflowOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new WorkflowOrchestrator();
  }
  return orchestratorInstance;
}

const EnterpriseWorkflowSchema = Type.Object({
  action: optionalStringEnum(["register", "start", "list"] as const),
  workflow: Type.Optional(Type.Any()), // Workflow
  workflowId: Type.Optional(Type.String()),
});

const EnterpriseApproveSchema = Type.Object({
  requestId: Type.String(),
  approvedBy: Type.String(),
  reason: Type.Optional(Type.String()),
});

const EnterpriseStatusSchema = Type.Object({
  executionId: Type.Optional(Type.String()),
});

export function createEnterpriseWorkflowTool(): AnyAgentTool {
  return {
    label: "Enterprise",
    name: "enterprise_workflow",
    description:
      "Define, start, or list autonomous enterprise workflows. Workflows execute tasks with safety guards and approval gates.",
    parameters: EnterpriseWorkflowSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const orchestrator = getOrchestrator();

      try {
        if (action === "register") {
          const workflowRaw = params.workflow;
          if (!workflowRaw || typeof workflowRaw !== "object") {
            return jsonResult({
              status: "error",
              error: "workflow object required for register action",
            });
          }
          const workflow = workflowRaw as Workflow;
          orchestrator.registerWorkflow(workflow);
          return jsonResult({
            status: "success",
            message: `Workflow ${workflow.id} registered`,
            workflowId: workflow.id,
          });
        } else if (action === "start") {
          const workflowId = readStringParam(params, "workflowId", {
            required: true,
          });
          const execution = await orchestrator.startWorkflow(workflowId);
          return jsonResult({
            status: "success",
            execution,
          });
        } else if (action === "list") {
          // Note: WorkflowOrchestrator doesn't expose listWorkflows yet
          // For now, return a placeholder
          return jsonResult({
            status: "success",
            message: "Workflow listing not yet implemented",
            workflows: [],
          });
        } else {
          return jsonResult({
            status: "error",
            error: `Unknown action: ${action}`,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createEnterpriseApproveTool(): AnyAgentTool {
  return {
    label: "Enterprise",
    name: "enterprise_approve",
    description:
      "Approve or reject a pending approval request in an enterprise workflow. Used for human-in-the-loop controls.",
    parameters: EnterpriseApproveSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const requestId = readStringParam(params, "requestId", { required: true });
      const approvedBy = readStringParam(params, "approvedBy", {
        required: true,
      });
      const reason = readStringParam(params, "reason");
      const orchestrator = getOrchestrator();
      const approvalGates = orchestrator.getApprovalGates();

      try {
        const approved = approvalGates.approve(requestId, approvedBy);
        if (approved) {
          return jsonResult({
            status: "success",
            message: `Approval request ${requestId} approved by ${approvedBy}`,
            requestId,
          });
        } else {
          return jsonResult({
            status: "error",
            error: `Failed to approve request ${requestId}. Request may not exist or already be processed.`,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createEnterpriseStatusTool(): AnyAgentTool {
  return {
    label: "Enterprise",
    name: "enterprise_status",
    description:
      "Get status of enterprise workflow execution or list pending approval requests.",
    parameters: EnterpriseStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const executionId = readStringParam(params, "executionId");
      const orchestrator = getOrchestrator();
      const approvalGates = orchestrator.getApprovalGates();

      try {
        if (executionId) {
          const execution = orchestrator.getExecution(executionId);
          if (execution) {
            return jsonResult({
              status: "success",
              execution,
            });
          } else {
            return jsonResult({
              status: "error",
              error: `Execution ${executionId} not found`,
            });
          }
        } else {
          // Return pending approvals
          const pendingApprovals = approvalGates.getPendingApprovals();
          return jsonResult({
            status: "success",
            pendingApprovals,
            count: pendingApprovals.length,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
