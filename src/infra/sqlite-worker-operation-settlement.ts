/** Native settlement is independent of whether delivery of the result succeeded. */
export type SqliteWorkerOperationSettlement =
  | { kind: "completed" }
  | { kind: "not-entered"; error: unknown }
  | { kind: "unknown"; error: unknown };

/** Private operation receipts describe completed work; they never grant write authority. */
export type SqliteWorkerNativeSettlement =
  | { kind: "completed"; committed?: { facts: unknown } }
  | { kind: "unknown"; committed?: { facts: unknown } };

export type SqliteWorkerNativeSettlementOwner = {
  readonly committed: { facts: unknown } | undefined;
  readonly settlement: SqliteWorkerNativeSettlement | undefined;
  waitForSettlement(
    deadlineMs: number,
  ): Extract<SqliteWorkerNativeSettlement, { kind: "completed" }>;
};

/** The broker resolves this only from the executing owner's settlement evidence. */
export type RetainedWorkerTransactionAdmission = {
  readonly settled: Promise<SqliteWorkerOperationSettlement>;
};
