/** Reuse the admitted update budget for its own durable ledger operations. */
export function updateRunLedgerOptions(run: {
  env: NodeJS.ProcessEnv;
  ledgerBusyTimeoutMs?: number;
}) {
  return { env: run.env, busyTimeoutMs: run.ledgerBusyTimeoutMs };
}
