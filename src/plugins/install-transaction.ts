export type PluginInstallTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const PLUGIN_INSTALL_TRANSACTION = Symbol.for("openclaw.pluginInstallTransaction");
const PLUGIN_INSTALL_TRANSACTION_REQUEST = Symbol.for("openclaw.pluginInstallTransactionRequest");
const PLUGIN_INSTALL_OWNER_MIGRATIONS = Symbol.for("openclaw.pluginInstallOwnerMigrations");

type PluginInstallTransactionRequest = {
  deferCommit: true;
  transactionSink?: PluginInstallTransaction[];
  assertOwned?: () => void;
};

export function attachPluginInstallTransaction<T extends object>(
  result: T,
  transaction: PluginInstallTransaction,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_TRANSACTION, {
    configurable: false,
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

export function requestDeferredPluginInstall<T extends object>(
  params: T,
  transactionSink?: PluginInstallTransaction[],
  assertOwned?: () => void,
): T {
  Object.defineProperty(params, PLUGIN_INSTALL_TRANSACTION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: {
      deferCommit: true,
      ...(transactionSink ? { transactionSink } : {}),
      ...(assertOwned ? { assertOwned } : {}),
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
    ? requestDeferredPluginInstall(target, request.transactionSink, request.assertOwned)
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
  assertOwned: () => void,
  run: (params: T, assertCurrent: () => void) => Promise<R>,
): Promise<R> {
  const request = resolvePluginInstallTransactionRequest(params);
  const initiatingAssert = request?.assertOwned;
  const callerBeforePersistentEffect = params.beforePersistentEffect;
  const transactions: PluginInstallTransaction[] = [];
  let refusal: { error: unknown } | undefined;
  const assertCurrent = () => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      initiatingAssert?.();
      assertOwned();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  assertCurrent();
  const beforePersistentEffect = () => {
    try {
      assertCurrent();
      const pending = callerBeforePersistentEffect?.();
      // Planning hooks may await consent. Synchronous hooks stay synchronous;
      // either form records refusal before an installer can normalize it.
      return pending?.then(assertCurrent, (error: unknown) => {
        refusal ??= { error };
        throw refusal.error;
      });
    } catch (error) {
      refusal ??= { error };
      throw refusal.error;
    }
  };
  const owned = requestDeferredPluginInstall(
    { ...params, beforePersistentEffect },
    request ? request.transactionSink : transactions,
    assertCurrent,
  );
  let result: R;
  try {
    result = await run(owned, assertCurrent);
    // Installers may return ordinary failures after a refused mutation. Keep
    // that refusal sticky, including falsy values, before settling any siblings.
    assertCurrent();
  } catch (error) {
    if (!request && !refusal) {
      try {
        await settlePluginInstallTransactions(transactions, "rollback");
      } catch (rollbackError) {
        if (!refusal) {
          throw new AggregateError([error, rollbackError], "Plugin install recovery failed", {
            cause: rollbackError,
          });
        }
      }
    }
    throw refusal ? refusal.error : error;
  }
  // The operation may have persisted its index. Cleanup failure must retain
  // the published package, never roll it back beneath that committed record.
  if (!request) {
    try {
      await settlePluginInstallTransactions(transactions, "commit");
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
): Promise<void> {
  const ordered = action === "rollback" ? transactions.toReversed() : transactions;
  const errors: unknown[] = [];
  for (const transaction of ordered) {
    try {
      await transaction[action]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Plugin install transaction ${action} failed`);
  }
}
