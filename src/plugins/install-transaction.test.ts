import { describe, expect, it, vi } from "vitest";
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
  // oxlint-disable-next-line typescript/only-throw-error -- Preserve falsy JavaScript callback refusals.
  throw reason;
}
function authority() {
  return {
    active: true,
    assertCurrent() {
      if (!this.active) {
        refuse(0);
      }
    },
  };
}

describe("plugin install transaction ownership", () => {
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
    await expect(
      install(
        async (owned) => {
          retainTransaction(owned, { commit, rollback });
          try {
            await owned.beforePersistentEffect!();
          } catch {
            /* Installer failure conversion. */
          }
          return { ok: false };
        },
        { beforePersistentEffect: async () => refuse(false) },
      ),
    ).rejects.toBe(false);
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
    await expect(
      install(async (owned) => {
        retainTransaction(owned, { commit, rollback });
        recordCommitted = true;
      }),
    ).rejects.toMatchObject({ errors: [failure] });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back admitted installs in reverse order when the operation fails", async () => {
    const settled: string[] = [];
    const failure = new Error("record write failed");
    await expect(
      install(async (owned) => {
        for (const name of ["first", "second"]) {
          retainTransaction(owned, {
            commit: async () => void settled.push(`commit:${name}`),
            rollback: async () => void settled.push(`rollback:${name}`),
          });
        }
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(settled).toEqual(["rollback:second", "rollback:first"]);
  });

  it("leaves deferred settlement with its caller and retains the original assertion", async () => {
    const transactions: PluginInstallTransaction[] = [];
    const refusal = new Error("original owner closed");
    let active = true;
    const params = requestDeferredPluginInstall({}, transactions, () => {
      if (!active) {
        throw refusal;
      }
    });
    const commit = vi.fn(async () => {});
    await install(async (owned, assertCurrent) => {
      retainTransaction(owned, {
        commit: async () => {
          assertCurrent();
          await commit();
        },
        rollback: async () => {
          assertCurrent();
        },
      });
    }, params);
    expect(transactions).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    active = false;
    const originalRequest = resolvePluginInstallTransactionRequest(params);
    originalRequest!.assertOwned = () => {};
    await expect(transactions[0]!.commit()).rejects.toBe(refusal);
    await expect(transactions[0]!.rollback()).rejects.toBe(refusal);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves a commit-time refusal without compensating published packages", async () => {
    const { rollback } = makeTransaction();
    const owner = authority();
    await expect(
      install(
        async (owned, assertCurrent) => {
          retainTransaction(owned, {
            commit: async () => {
              await Promise.resolve();
              owner.active = false;
              assertCurrent();
            },
            rollback,
          });
        },
        {},
        () => owner.assertCurrent(),
      ),
    ).rejects.toBe(0);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("keeps a falsy refusal after an installer converts it into an ordinary result", async () => {
    const owner = authority();
    await expect(
      install(
        async (_owned, assertCurrent) => {
          owner.active = false;
          try {
            assertCurrent();
          } catch {
            /* The installer reports a regular failed result. */
          }
          owner.active = true;
          return { ok: false };
        },
        {},
        () => owner.assertCurrent(),
      ),
    ).rejects.toBe(0);
  });
});

describe("plugin install transaction settlement", () => {
  it.each(["commit", "rollback"] as const)(
    "does not replay a successful %s through duplicate or later settlement",
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
    await expect(
      settlePluginInstallTransactions([pending, settled], "rollback"),
    ).rejects.toMatchObject({
      errors: [failure],
    });
    await settlePluginInstallTransactions([pending, settled], "rollback");
    expect(pending.rollback).toHaveBeenCalledTimes(2);
    expect(settled.rollback).toHaveBeenCalledOnce();
  });
});

it.each([false, true])(
  "preserves the peer-link failure when rollback fails: %s",
  async (rollbackFails) => {
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

    const failure: unknown = await finalizePluginUpdateSummary({
      config: {},
      changed: true,
      outcomes: [],
      ranNpmInstaller: true,
      logger: {},
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
  },
);
