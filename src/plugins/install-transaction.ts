export type PluginInstallTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const PLUGIN_INSTALL_TRANSACTION = Symbol.for("openclaw.pluginInstallTransaction");
const PLUGIN_INSTALL_TRANSACTION_REQUEST = Symbol.for("openclaw.pluginInstallTransactionRequest");
const PLUGIN_INSTALL_OWNER_MIGRATIONS = Symbol.for("openclaw.pluginInstallOwnerMigrations");
const settlements = new WeakMap<PluginInstallTransaction, Promise<void>>();

type PluginInstallTransactionRequest = {
  deferCommit: true;
  transactionSink?: PluginInstallTransaction[];
  assertOwned?: () => void;
  prepareSettlement?: () => void | Promise<void>;
};

export function attachPluginInstallTransaction<T extends object>(
  result: T,
  transaction: PluginInstallTransaction,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_TRANSACTION, {
    configurable: true,
    enumerable: true,
    value: transaction,
  });
  return result;
}

export function resolvePluginInstallTransaction(
  result: object,
): PluginInstallTransaction | undefined {
  return (result as { [PLUGIN_INSTALL_TRANSACTION]?: PluginInstallTransaction })[
    PLUGIN_INSTALL_TRANSACTION
  ];
}

export function takePluginInstallTransaction(result: object): PluginInstallTransaction | undefined {
  const transaction = resolvePluginInstallTransaction(result);
  Reflect.deleteProperty(result, PLUGIN_INSTALL_TRANSACTION);
  return transaction;
}

export function requestDeferredPluginInstall<T extends object>(
  params: T,
  transactionSink?: PluginInstallTransaction[],
  assertOwned?: () => void,
  prepareSettlement?: () => void | Promise<void>,
): T {
  Object.defineProperty(params, PLUGIN_INSTALL_TRANSACTION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: {
      deferCommit: true,
      ...(transactionSink ? { transactionSink } : {}),
      ...(assertOwned ? { assertOwned } : {}),
      ...(prepareSettlement ? { prepareSettlement } : {}),
    } satisfies PluginInstallTransactionRequest,
  });
  return params;
}

export function copyPluginInstallTransactionRequest<T extends object>(
  source: object,
  target: T,
): T {
  const request = resolvePluginInstallTransactionRequest(source);
  return request
    ? requestDeferredPluginInstall(
        target,
        request.transactionSink,
        request.assertOwned,
        request.prepareSettlement,
      )
    : target;
}

export function resolvePluginInstallTransactionRequest(
  params: object,
): PluginInstallTransactionRequest | undefined {
  return (params as { [PLUGIN_INSTALL_TRANSACTION_REQUEST]?: PluginInstallTransactionRequest })[
    PLUGIN_INSTALL_TRANSACTION_REQUEST
  ];
}

/** Keep direct and deferred installs bound to the owner that admitted them. */
export async function withPluginInstallTransactions<
  T extends { beforePersistentEffect?: () => void | Promise<void> },
  R,
>(
  params: T,
  lease: { assertCurrent(): void; assertOwned(): void | Promise<void> },
  run: (
    params: T,
    assertCurrent: () => void,
    prepareEffect: () => void | Promise<void>,
  ) => Promise<R>,
): Promise<R> {
  const request = resolvePluginInstallTransactionRequest(params);
  const initiatingAssert = request?.assertOwned;
  const initiatingPreparation = request?.prepareSettlement;
  const callerBeforePersistentEffect = params.beforePersistentEffect;
  const transactions: PluginInstallTransaction[] = [];
  let refusal: { error: unknown } | undefined;
  const assertCurrent = () => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      initiatingAssert?.();
      lease.assertCurrent();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  assertCurrent();
  const refuse = (error: unknown): never => {
    refusal ??= { error };
    throw refusal.error;
  };
  const prepareEffect = () => {
    try {
      assertCurrent();
      const verifyLease = () => {
        const pending = lease.assertOwned();
        return pending ? pending.then(assertCurrent, refuse) : assertCurrent();
      };
      const pending = initiatingPreparation?.();
      return pending ? pending.then(verifyLease).catch(refuse) : verifyLease();
    } catch (error) {
      return refuse(error);
    }
  };
  const beforePersistentEffect = () => {
    try {
      assertCurrent();
      const pending = callerBeforePersistentEffect?.();
      // Native callers keep synchronous planning; worker owners await durable authority.
      return pending ? pending.then(prepareEffect, refuse) : prepareEffect();
    } catch (error) {
      return refuse(error);
    }
  };
  const owned = requestDeferredPluginInstall(
    { ...params, beforePersistentEffect },
    request ? request.transactionSink : transactions,
    assertCurrent,
    prepareEffect,
  );
  let result: R;
  try {
    result = await run(owned, assertCurrent, prepareEffect);
    // Installers may return ordinary failures after a refused mutation. Keep
    // that refusal sticky, including falsy values, before settling any siblings.
    assertCurrent();
  } catch (error) {
    if (!request && !refusal) {
      try {
        await settlePluginInstallTransactions(transactions, "rollback", { error }, prepareEffect);
      } catch (rollbackError) {
        if (!refusal) {
          throw rollbackError;
        }
      }
    }
    throw refusal ? refusal.error : error;
  }
  // The operation may have persisted its index. Cleanup failure must retain
  // the published package, never roll it back beneath that committed record.
  if (!request) {
    try {
      await settlePluginInstallTransactions(transactions, "commit", undefined, prepareEffect);
    } catch (error) {
      throw refusal ? refusal.error : error;
    }
  }
  return result;
}

export function retainPluginInstallTransaction(params: object, result: object): void {
  const transaction = resolvePluginInstallTransaction(result);
  if (transaction) {
    resolvePluginInstallTransactionRequest(params)?.transactionSink?.push(transaction);
  }
}

export function attachPluginInstallOwnerMigrations<T extends object>(
  result: T,
  migrations: Readonly<Record<string, string>>,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_OWNER_MIGRATIONS, {
    configurable: false,
    enumerable: true,
    value: migrations,
  });
  return result;
}

export function resolvePluginInstallOwnerMigrations(
  result: object,
): Readonly<Record<string, string>> | undefined {
  return (result as { [PLUGIN_INSTALL_OWNER_MIGRATIONS]?: Readonly<Record<string, string>> })[
    PLUGIN_INSTALL_OWNER_MIGRATIONS
  ];
}

export async function settlePluginInstallTransactions(
  transactions: readonly PluginInstallTransaction[],
  action: "commit" | "rollback",
  primaryFailure?: { error: unknown },
  prepareEffect?: () => void | Promise<void>,
): Promise<void> {
  const ordered = action === "rollback" ? transactions.toReversed() : transactions;
  const errors: unknown[] = [];
  for (const transaction of new Set(ordered)) {
    try {
      let settlement = settlements.get(transaction);
      if (!settlement) {
        settlement = Promise.resolve()
          .then(async () => {
            await prepareEffect?.();
            return transaction[action]();
          })
          .catch((error: unknown) => {
            // Failed I/O retains the directory owner's retryable rollback progress.
            settlements.delete(transaction);
            throw error;
          });
        settlements.set(transaction, settlement);
      }
      await settlement;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const message = `Plugin install transaction ${action} failed`;
    throw primaryFailure
      ? new AggregateError(
          [primaryFailure.error, ...errors],
          `${String(primaryFailure.error)}; ${message}`,
          { cause: primaryFailure.error },
        )
      : new AggregateError(errors, message);
  }
}
