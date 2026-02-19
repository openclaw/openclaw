import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ApprovalGates } from "./approval-gates.js";
import { SafetyGuards } from "./safety-guards.js";
import type {
  Workflow,
  WorkflowExecution,
  WorkflowStep,
} from "./types.js";

/**
 * Orchestrates autonomous enterprise workflows with safety guards and approval gates.
 */
export class WorkflowOrchestrator {
  private config: OpenClawConfig;
  private workflows: Map<string, Workflow> = new Map();
  private executions: Map<string, WorkflowExecution> = new Map();
  private approvalGates: ApprovalGates;
  private safetyGuards: SafetyGuards;

  constructor() {
    this.config = loadConfig();
    this.approvalGates = new ApprovalGates();
    const enterpriseConfig = this.config.enterprise;
    this.safetyGuards = new SafetyGuards(
      enterpriseConfig?.safetyGuards,
    );
  }

  /**
   * Registers a workflow.
   */
  registerWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  /**
   * Starts a workflow execution.
   */
  async startWorkflow(workflowId: string): Promise<WorkflowExecution> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (!workflow.enabled) {
      throw new Error(`Workflow is disabled: ${workflowId}`);
    }

    const execution: WorkflowExecution = {
      id: `exec_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      workflowId,
      status: "running",
      startedAt: new Date(),
      stepResults: {},
      errors: [],
    };

    this.executions.set(execution.id, execution);

    // Start execution asynchronously
    this.executeWorkflow(execution, workflow).catch((error) => {
      execution.status = "failed";
      execution.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      this.executions.set(execution.id, execution);
    });

    return execution;
  }

  /**
   * Executes a workflow.
   */
  private async executeWorkflow(
    execution: WorkflowExecution,
    workflow: Workflow,
  ): Promise<void> {
    let currentStepId = workflow.steps[0]?.id;

    while (currentStepId) {
      const step = workflow.steps.find((s) => s.id === currentStepId);
      if (!step) {
        execution.status = "failed";
        execution.errors.push(`Step not found: ${currentStepId}`);
        break;
      }

      execution.currentStepId = currentStepId;

      try {
        const result = await this.executeStep(execution, step, workflow);
        execution.stepResults[currentStepId] = result;

        if (step.requiresApproval && step.approvalGate) {
          const approved = await this.waitForApproval(
            execution.id,
            currentStepId,
            step.approvalGate,
            `Approval required for step: ${step.name}`,
          );

          if (!approved) {
            execution.status = "paused";
            break;
          }
        }

        // Determine next step
        if (step.onSuccess) {
          currentStepId = step.onSuccess;
        } else {
          // Find next step in sequence
          const currentIndex = workflow.steps.findIndex((s) => s.id === currentStepId);
          if (currentIndex < workflow.steps.length - 1) {
            currentStepId = workflow.steps[currentIndex + 1].id;
          } else {
            currentStepId = undefined;
          }
        }
      } catch (error) {
        execution.errors.push(
          `Step ${step.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        if (step.onFailure) {
          currentStepId = step.onFailure;
        } else {
          execution.status = "failed";
          break;
        }
      }
    }

    if (execution.status === "running") {
      execution.status = "completed";
      execution.completedAt = new Date();
    }

    this.executions.set(execution.id, execution);
  }

  /**
   * Executes a single workflow step.
   */
  private async executeStep(
    execution: WorkflowExecution,
    step: WorkflowStep,
    workflow: Workflow,
  ): Promise<unknown> {
    // Check safety guards
    const guardCheck = this.safetyGuards.isAllowed(step.action || step.name, {
      stepId: step.id,
      workflowId: workflow.id,
    });

    if (!guardCheck.allowed) {
      throw new Error(`Safety guard blocked: ${guardCheck.reason}`);
    }

    switch (step.type) {
      case "task":
        return await this.executeTask(step, execution);
      case "approval":
        return await this.executeApproval(step, execution);
      case "condition":
        return await this.executeCondition(step, execution);
      case "parallel":
        return await this.executeParallel(step, execution, workflow);
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * Executes a task step.
   */
  private async executeTask(
    step: WorkflowStep,
    execution: WorkflowExecution,
  ): Promise<unknown> {
    // In practice, this would execute the actual task
    // For now, return a placeholder
    return { stepId: step.id, action: step.action, status: "completed" };
  }

  /**
   * Executes an approval step.
   */
  private async executeApproval(
    step: WorkflowStep,
    execution: WorkflowExecution,
  ): Promise<unknown> {
    if (!step.approvalGate) {
      throw new Error("Approval step requires approvalGate");
    }

    const approved = await this.waitForApproval(
      execution.id,
      step.id,
      step.approvalGate,
      step.name,
    );

    return { approved };
  }

  /**
   * Executes a condition step.
   */
  private async executeCondition(
    step: WorkflowStep,
    execution: WorkflowExecution,
  ): Promise<unknown> {
    // In practice, this would evaluate the condition
    // For now, return a placeholder
    return { condition: step.condition, result: true };
  }

  /**
   * Executes parallel steps.
   */
  private async executeParallel(
    step: WorkflowStep,
    execution: WorkflowExecution,
    workflow: Workflow,
  ): Promise<unknown> {
    if (!step.parallelSteps) {
      throw new Error("Parallel step requires parallelSteps");
    }

    const parallelExecutions = step.parallelSteps.map((stepId) => {
      const parallelStep = workflow.steps.find((s) => s.id === stepId);
      if (!parallelStep) {
        throw new Error(`Parallel step not found: ${stepId}`);
      }
      return this.executeStep(execution, parallelStep, workflow);
    });

    return await Promise.all(parallelExecutions);
  }

  /**
   * Waits for approval.
   */
  private async waitForApproval(
    executionId: string,
    stepId: string,
    gateId: string,
    message: string,
  ): Promise<boolean> {
    const request = await this.approvalGates.requestApproval(
      executionId,
      stepId,
      gateId,
      message,
    );

    // Poll for approval (in practice, would use events/callbacks)
    const maxWait = 3600000; // 1 hour
    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const updated = this.approvalGates.getRequest(request.id);
      if (updated && updated.status !== "pending") {
        return updated.status === "approved";
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return false; // Timeout
  }

  /**
   * Gets workflow execution status.
   */
  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Gets approval gates instance.
   */
  getApprovalGates(): ApprovalGates {
    return this.approvalGates;
  }
}
