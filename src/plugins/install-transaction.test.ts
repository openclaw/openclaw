import { describe, expect, it, vi } from "vitest";
import {
  attachPluginInstallTransaction,
  requestDeferredPluginInstall,
  resolvePluginInstallTransactionRequest,
  retainPluginInstallTransaction,
  withPluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";

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
