export type WorkflowStep = {
  id: string;
  name: string;
  type: "task" | "approval" | "condition" | "parallel";
  action?: string;
  condition?: string;
  requiresApproval?: boolean;
  approvalGate?: string;
  onSuccess?: string; // next step ID
  onFailure?: string; // next step ID
  parallelSteps?: string[]; // step IDs for parallel execution
};

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  currentStepId?: string;
  startedAt: Date;
  completedAt?: Date;
  stepResults: Record<string, unknown>;
  errors: string[];
};

export type ApprovalRequest = {
  id: string;
  workflowExecutionId: string;
  stepId: string;
  gateId: string;
  message: string;
  requestedAt: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  approvedBy?: string;
  rejectedBy?: string;
  status: "pending" | "approved" | "rejected" | "expired";
};

export type SafetyGuardConfig = {
  payments: boolean;
  userData: boolean;
  destructive: boolean;
  externalApi: boolean;
};
