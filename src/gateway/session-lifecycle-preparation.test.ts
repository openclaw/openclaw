import { expect, test, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { commitPreparedSessionWorkspace } from "./session-lifecycle-preparation.js";

test("keeps a committed workspace when releasing source custody fails", async () => {
  const failure = new Error("source release failed");
  const rollback = vi.fn();
  await expect(
    commitPreparedSessionWorkspace(
      {
        rollback,
        withCommit: async (run) => {
          await run(() => {});
          throw failure;
        },
      },
      async (onCommitted) => onCommitted(),
    ),
  ).rejects.toBe(failure);
  expect(rollback).not.toHaveBeenCalled();
});

test.each([false, true])(
  "settles an unconfirmed workspace (native outcome unknown: %s)",
  async (unknown) => {
    const failure = unknown
      ? new Error("recovery failed", {
          cause: new SqliteWorkerError("native completion was lost", "outcome-unknown"),
        })
      : new Error("commit refused");
    const rollback = vi.fn();
    await expect(
      commitPreparedSessionWorkspace({ rollback }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(rollback).toHaveBeenCalledTimes(unknown ? 0 : 1);
  },
);

test("rolls back a refused creation without changing its result", async () => {
  const result = { status: "conflict" };
  const rollback = vi.fn();
  await expect(commitPreparedSessionWorkspace({ rollback }, async () => result)).resolves.toBe(
    result,
  );
  expect(rollback).toHaveBeenCalledOnce();
});
