import type {
  WorkerExecApprovalParams,
  WorkerExecApprovalResult,
} from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";

export type WorkerExecApprovalTurnSource = {
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

export type WorkerExecApprovalOwner = (
  request: WorkerExecApprovalParams,
  authority: {
    assertCurrent(): void;
    call: <T>(
      method: "exec.approval.request" | "exec.approval.waitDecision",
      params: Record<string, unknown>,
      turnSource: WorkerExecApprovalTurnSource | undefined,
    ) => Promise<T>;
    signal?: AbortSignal;
    environmentId: string;
  },
) => Promise<WorkerExecApprovalResult>;
