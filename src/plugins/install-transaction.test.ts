import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  attachPluginInstallTransaction,
  copyPluginInstallTransactionRequest,
  requestDeferredPluginInstall,
  resolvePluginInstallTransactionRequest,
  retainPluginInstallTransaction,
  settlePluginInstallTransactions,
  withPluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import {
  createPluginUpdateTransactionState,
  finalizePluginUpdateSummary,
} from "./update-summary.js";

const repairPeerLinks = vi.hoisted(() => vi.fn());
vi.mock("./plugin-peer-link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-peer-link.js")>()),
  repairInstalledOpenClawHostLinks: repairPeerLinks,
}));

function retainTransaction(owner: object, transaction: PluginInstallTransaction) {
  retainPluginInstallTransaction(owner, attachPluginInstallTransaction({}, transaction));
}

const makeTransaction = () => ({ commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) });
type InstallParams = { beforePersistentEffect?: () => void | Promise<void> };
function install(
  run: Parameters<typeof withPluginInstallTransactions>[2],
  params: InstallParams = {},
  assertOwned = () => {},
) {
  return withPluginInstallTransactions(params, { assertCurrent: assertOwned, assertOwned }, run);
}
function refuse(reason: unknown): never {
  throw reason;
}
function authority(refusal: unknown = 0) {
  return {
    active: true,
    assertCurrent() {
      if (!this.active) {
        refuse(refusal);
      }
    },
  };
}

it("carries the original awaited settlement owner through copied install requests", async () => {
  const refusal = new Error("original durable owner retired");
  const prepareSettlement = vi.fn(async () => {
    throw refusal;
  });
  const source = requestDeferredPluginInstall({}, undefined, () => {}, prepareSettlement);
  const copied = copyPluginInstallTransactionRequest(source, {});
  await expect(
    install(async (owned) => {
      await owned.beforePersistentEffect?.();
    }, copied),
  ).rejects.toBe(refusal);
  expect(prepareSettlement).toHaveBeenCalledOnce();
});

it("keeps synchronous planning callbacks synchronous", async () => {
  const beforePersistentEffect = vi.fn(() => {});
  await install(
    async (owned) => {
      expect(owned.beforePersistentEffect!()).toBeUndefined();
    },
    { beforePersistentEffect },
  );
  expect(beforePersistentEffect).toHaveBeenCalledOnce();
});

it.each([false, true])("commits after publication (cleanupFails=%s)", async (cleanupFails) => {
  const transaction = makeTransaction();
  const failure = new Error("backup identity changed");
  transaction.commit.mockImplementation(async () => {
    if (cleanupFails) {
      throw failure;
    }
  });
  const operation = install(async (owned) => {
    retainTransaction(owned, transaction);
    expect(transaction.commit).not.toHaveBeenCalled();
  });
  if (cleanupFails) {
    await expect(operation).rejects.toMatchObject({ errors: [failure] });
  } else {
    await operation;
  }
  expect(transaction.commit).toHaveBeenCalledOnce();
  expect(transaction.rollback).not.toHaveBeenCalled();
});

it.each([false, true])("rolls back in reverse order (rollbackFails=%s)", async (rollbackFails) => {
  const settled: string[] = [];
  const failure = new Error("record write failed");
  const recoveryFailure = new Error("backup restore failed");
  const operation = install(async (owned) => {
    for (const name of ["first", "second"]) {
      retainTransaction(owned, {
        commit: async () => void settled.push(`commit:${name}`),
        rollback: async () => {
          settled.push(`rollback:${name}`);
          if (rollbackFails && name === "second") {
            throw recoveryFailure;
          }
        },
      });
    }
    throw failure;
  });
  if (rollbackFails) {
    const outcome: unknown = await operation.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome).toMatchObject({ cause: failure, errors: [failure, recoveryFailure] });
    expect(String(outcome)).toContain(failure.message);
  } else {
    await expect(operation).rejects.toBe(failure);
  }
  expect(settled).toEqual(["rollback:second", "rollback:first"]);
});

it("leaves deferred settlement with its caller and retains the original assertion", async () => {
  const transactions: PluginInstallTransaction[] = [];
  const refusal = new Error("original owner closed");
  const owner = authority(refusal);
  const params = requestDeferredPluginInstall({}, transactions, () => owner.assertCurrent());
  const commit = vi.fn(async () => {});
  await install(async (owned, assertCurrent) => {
    retainTransaction(owned, {
      commit: async () => {
        assertCurrent();
        await commit();
      },
      rollback: async () => assertCurrent(),
    });
  }, params);
  expect(transactions).toHaveLength(1);
  expect(commit).not.toHaveBeenCalled();
  owner.active = false;
  const originalRequest = resolvePluginInstallTransactionRequest(params);
  originalRequest!.assertOwned = () => {};
  await expect(transactions[0]!.commit()).rejects.toBe(refusal);
  await expect(transactions[0]!.rollback()).rejects.toBe(refusal);
  expect(commit).not.toHaveBeenCalled();
});

it.each(["planning", "commit", "operation"] as const)(
  "keeps a falsy %s refusal sticky",
  async (phase) => {
    const refusal = phase === "planning" ? false : 0;
    const owner = authority(refusal);
    const transaction = makeTransaction();
    const operation = install(
      async (owned, assertCurrent) => {
        const revoke = () => {
          owner.active = false;
          assertCurrent();
        };
        transaction.commit.mockImplementation(async () => {
          await Promise.resolve();
          revoke();
        });
        retainTransaction(owned, transaction);
        if (phase === "commit") {
          return undefined;
        }
        try {
          if (phase === "planning") {
            await owned.beforePersistentEffect!();
          } else {
            revoke();
          }
        } catch {}
        owner.active = true;
        return { ok: false };
      },
      {
        beforePersistentEffect: async () => refuse(refusal),
      },
      () => owner.assertCurrent(),
    );
    await expect(operation).rejects.toBe(refusal);
    expect(transaction.rollback).not.toHaveBeenCalled();
    if (phase !== "commit") {
      expect(transaction.commit).not.toHaveBeenCalled();
    }
  },
);
it.each(["commit", "rollback"] as const)(
  "settles %s once across concurrent and later calls",
  async (action) => {
    const transaction = makeTransaction();

    await Promise.all([
      settlePluginInstallTransactions([transaction, transaction], action),
      settlePluginInstallTransactions([transaction], action),
    ]);
    await settlePluginInstallTransactions([transaction], "commit");
    await settlePluginInstallTransactions([transaction], "rollback");

    expect(transaction[action]).toHaveBeenCalledOnce();
    expect(transaction[action === "commit" ? "rollback" : "commit"]).not.toHaveBeenCalled();
  },
);

it("retains failed rollback for recovery without replaying settled siblings", async () => {
  const failure = new Error("backup restore failed");
  const settled = makeTransaction();
  const pending = {
    commit: vi.fn(async () => {}),
    rollback: vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(),
  };
  const attempt = settlePluginInstallTransactions([pending, settled], "rollback");
  await expect(attempt).rejects.toMatchObject({ errors: [failure] });
  await settlePluginInstallTransactions([pending, settled], "rollback");
  expect(pending.rollback).toHaveBeenCalledTimes(2);
  expect(settled.rollback).toHaveBeenCalledOnce();
});

it.each([false, true])("retains peer-link failure (rollbackFails=%s)", async (rollbackFails) => {
  const root = new Error("Cannot repair OpenClaw peer link: target is not a directory");
  const cleanup = new Error("Cannot restore plugin backup");
  repairPeerLinks.mockRejectedValueOnce(root);
  const transaction = makeTransaction();
  if (rollbackFails) {
    transaction.rollback.mockRejectedValueOnce(cleanup);
  }
  const transactionState = createPluginUpdateTransactionState({});
  transactionState.transactions.push(transaction);

  const summary = { config: {}, changed: true, outcomes: [], ranNpmInstaller: true, logger: {} };
  const failure: unknown = await finalizePluginUpdateSummary({
    ...summary,
    transactionState,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(root.message);
  if (rollbackFails) {
    expect(failure).toMatchObject({ cause: root, errors: [root, cleanup] });
  } else {
    expect(failure).toBe(root);
  }
  expect(transaction.rollback).toHaveBeenCalledOnce();
});

it.each(["commit", "rollback"] as const)(
  "awaits current durable authority before %s effects",
  async (action) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refusal = new Error("install lease replaced");
    const transaction = makeTransaction();
    let current = true;
    const operation = withPluginInstallTransactions(
      {},
      {
        assertCurrent() {},
        async assertOwned() {
          entered.resolve();
          await release.promise;
          if (!current) {
            throw refusal;
          }
        },
      },
      async (owned) => {
        retainTransaction(owned, transaction);
        if (action === "rollback") {
          throw new Error("publication failed");
        }
      },
    );
    const rejected = expect(operation).rejects.toBe(refusal);
    await awaitGateBeforeSettlement(
      entered.promise,
      operation,
      "settlement never verified authority",
    );
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
    current = false;
    release.resolve();
    await rejected;
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
  },
);
