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

describe("plugin install transaction ownership", () => {
  it("keeps synchronous planning callbacks synchronous", async () => {
    const beforePersistentEffect = vi.fn(() => {});
    await withPluginInstallTransactions(
      { beforePersistentEffect },
      () => {},
      async (owned) => {
        expect(owned.beforePersistentEffect()).toBeUndefined();
      },
    );
    expect(beforePersistentEffect).toHaveBeenCalledOnce();
  });

  it("does not compensate earlier installs after an asynchronous planning refusal", async () => {
    const rollback = vi.fn(async () => {});
    const commit = vi.fn(async () => {});
    const beforePersistentEffect = async () => {
      // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
      throw false;
    };
    await expect(
      withPluginInstallTransactions(
        { beforePersistentEffect },
        () => {},
        async (owned) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction({}, { commit, rollback }),
          );
          try {
            await owned.beforePersistentEffect();
          } catch {
            /* Installer failure conversion. */
          }
          return { ok: false };
        },
      ),
    ).rejects.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("commits direct installs after their operation succeeds", async () => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    await withPluginInstallTransactions(
      {},
      () => {},
      async (owned) => {
        retainPluginInstallTransaction(
          owned,
          attachPluginInstallTransaction({}, { commit, rollback }),
        );
        expect(commit).not.toHaveBeenCalled();
      },
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back admitted installs in reverse order when the operation fails", async () => {
    const settled: string[] = [];
    const failure = new Error("record write failed");
    await expect(
      withPluginInstallTransactions(
        {},
        () => {},
        async (owned) => {
          for (const name of ["first", "second"]) {
            retainPluginInstallTransaction(
              owned,
              attachPluginInstallTransaction(
                {},
                {
                  commit: async () => {
                    settled.push(`commit:${name}`);
                  },
                  rollback: async () => {
                    settled.push(`rollback:${name}`);
                  },
                },
              ),
            );
          }
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(settled).toEqual(["rollback:second", "rollback:first"]);
  });

  it("preserves published state when final cleanup fails after the record commit", async () => {
    const rollback = vi.fn(async () => {});
    const failure = new Error("backup identity changed");
    let recordCommitted = false;
    const commit = vi.fn(async () => {
      expect(recordCommitted).toBe(true);
      throw failure;
    });
    await expect(
      withPluginInstallTransactions(
        {},
        () => {},
        async (owned) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction({}, { commit, rollback }),
          );
          recordCommitted = true;
        },
      ),
    ).rejects.toMatchObject({ errors: [failure] });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
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
    await withPluginInstallTransactions(
      params,
      () => {},
      async (owned, assertCurrent) => {
        retainPluginInstallTransaction(
          owned,
          attachPluginInstallTransaction(
            {},
            {
              commit: async () => {
                assertCurrent();
                await commit();
              },
              rollback: async () => {
                assertCurrent();
              },
            },
          ),
        );
      },
    );
    expect(transactions).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    active = false;
    const originalRequest = resolvePluginInstallTransactionRequest(params);
    if (!originalRequest) {
      throw new Error("missing original request");
    }
    originalRequest.assertOwned = () => {};
    await expect(transactions[0]!.commit()).rejects.toBe(refusal);
    await expect(transactions[0]!.rollback()).rejects.toBe(refusal);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves a commit-time refusal without compensating published packages", async () => {
    const rollback = vi.fn(async () => {});
    let active = true;
    await expect(
      withPluginInstallTransactions(
        {},
        () => {
          if (!active) {
            // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
            throw 0;
          }
        },
        async (owned, assertCurrent) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction(
              {},
              {
                commit: async () => {
                  await Promise.resolve();
                  active = false;
                  assertCurrent();
                },
                rollback,
              },
            ),
          );
        },
      ),
    ).rejects.toBe(0);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("keeps a falsy refusal after an installer converts it into an ordinary result", async () => {
    let active = true;
    await expect(
      withPluginInstallTransactions(
        {},
        () => {
          if (!active) {
            // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
            throw 0;
          }
        },
        async (_owned, assertCurrent) => {
          active = false;
          try {
            assertCurrent();
          } catch {
            /* The installer reports a regular failed result. */
          }
          active = true;
          return { ok: false };
        },
      ),
    ).rejects.toBe(0);
  });
});

describe("plugin install transaction settlement", () => {
  it.each(["commit", "rollback"] as const)(
    "does not replay a successful %s through duplicate or later settlement",
    async (action) => {
      const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };

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
    const settled = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
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

describe("plugin update finalization", () => {
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
});
