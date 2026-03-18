type PendingExecutor = {
  approvalId: string;
  method: string;
  subject: string;
  createdAt: number;
  executor: () => Promise<void>;
};

export class GovdossApprovalRuntimeRegistry {
  private readonly executors = new Map<string, PendingExecutor>();

  register(record: PendingExecutor): PendingExecutor {
    this.executors.set(record.approvalId, record);
    return record;
  }

  get(approvalId: string): PendingExecutor | null {
    return this.executors.get(approvalId) ?? null;
  }

  consume(approvalId: string): PendingExecutor | null {
    const record = this.executors.get(approvalId) ?? null;
    if (record) {
      this.executors.delete(approvalId);
    }
    return record;
  }

  remove(approvalId: string): void {
    this.executors.delete(approvalId);
  }

  list(): Array<Omit<PendingExecutor, "executor">> {
    return [...this.executors.values()]
      .map(({ executor: _executor, ...rest }) => rest)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

export const govdossApprovalRuntimeRegistry = new GovdossApprovalRuntimeRegistry();
