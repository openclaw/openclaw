import { expect, it, vi } from "vitest";
import {
  attachPluginInstallTransaction,
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
vi.mock("./update-config.js", () => ({ repairOpenClawPeerLinksForNpmInstalls: repairPeerLinks }));

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
  return withPluginInstallTransactions(params, assertOwned, run);
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

it("does not compensate earlier installs after an asynchronous planning refusal", async () => {
  const { commit, rollback } = makeTransaction();
  const operation = install(
    async (owned) => {
      retainTransaction(owned, { commit, rollback });
      try {
        await owned.beforePersistentEffect!();
      } catch {}
      return { ok: false };
    },
    { beforePersistentEffect: async () => refuse(false) },
  );
  await expect(operation).rejects.toBe(false);
  expect(commit).not.toHaveBeenCalled();
  expect(rollback).not.toHaveBeenCalled();
});

it("commits direct installs after their operation succeeds", async () => {
  const { commit, rollback } = makeTransaction();
  await install(async (owned) => {
    retainTransaction(owned, { commit, rollback });
    expect(commit).not.toHaveBeenCalled();
  });
  expect(commit).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
});

it("retains the original install failure when rollback also fails", async () => {
  const failure = new Error("record write failed");
  const recoveryFailure = new Error("backup restore failed");
  const rollback = vi.fn<() => Promise<void>>().mockRejectedValue(recoveryFailure);
  const outcome = await install(async (owned) => {
    retainTransaction(owned, { commit: vi.fn(), rollback });
    throw failure;
  }).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome).toMatchObject({ cause: failure, errors: [failure, recoveryFailure] });
  expect(String(outcome)).toContain(failure.message);
  expect(rollback).toHaveBeenCalledOnce();
});

it("preserves published state when final cleanup fails after the record commit", async () => {
  const { rollback } = makeTransaction();
  const failure = new Error("backup identity changed");
  let recordCommitted = false;
  const commit = vi.fn(async () => {
    expect(recordCommitted).toBe(true);
    throw failure;
  });
  const operation = install(async (owned) => {
    retainTransaction(owned, { commit, rollback });
    recordCommitted = true;
  });
  await expect(operation).rejects.toMatchObject({ errors: [failure] });
  expect(commit).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
});

it("rolls back admitted installs in reverse order when the operation fails", async () => {
  const settled: string[] = [];
  const failure = new Error("record write failed");
  const operation = install(async (owned) => {
    for (const name of ["first", "second"]) {
      retainTransaction(owned, {
        commit: async () => void settled.push(`commit:${name}`),
        rollback: async () => void settled.push(`rollback:${name}`),
      });
    }
    throw failure;
  });
  await expect(operation).rejects.toBe(failure);
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

it.each(["commit", "operation"] as const)("keeps a falsy %s refusal sticky", async (phase) => {
  const owner = authority();
  const { rollback } = makeTransaction();
  const operation = install(
    async (owned, assertCurrent) => {
      const revoke = () => {
        owner.active = false;
        assertCurrent();
      };
      if (phase === "commit") {
        retainTransaction(owned, {
          commit: async () => {
            await Promise.resolve();
            revoke();
          },
          rollback,
        });
        return undefined;
      }
      try {
        revoke();
      } catch {
        /* The installer reports a regular failed result. */
      }
      owner.active = true;
      return { ok: false };
    },
    {},
    () => owner.assertCurrent(),
  );
  await expect(operation).rejects.toBe(0);
  expect(rollback).not.toHaveBeenCalled();
});
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
  const rollback = vi.fn(async () => {
    if (rollbackFails) {
      throw cleanup;
    }
  });
  const transactionState = createPluginUpdateTransactionState({});
  transactionState.transactions.push({ commit: vi.fn(), rollback });

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
  expect(rollback).toHaveBeenCalledOnce();
});
