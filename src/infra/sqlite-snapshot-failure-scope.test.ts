import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it } from "vitest";
import { withSqliteSnapshotFailureScope } from "./sqlite-error-diagnostics.js";
import { settleSqliteSnapshotRequest } from "./sqlite-readonly-location-cleanup.js";

it.each([false, true])(
  "retains the final failed snapshot request after optional handling (cleanup fails: %s)",
  async (cleanupFails) => {
    const failure = Object.freeze(new Error("native snapshot allocation failed"));
    const cleanupFailure = Object.freeze(new Error("native snapshot cleanup failed"));
    const cleanup = createRetainedOperation<void>(() => {});
    if (cleanupFails) {
      cleanup.reject(cleanupFailure);
    } else {
      cleanup.resolve();
    }
    let observed: unknown;
    const inspection = withSqliteSnapshotFailureScope(async () => {
      try {
        await settleSqliteSnapshotRequest({
          result: Promise.reject(failure),
          startClose: () => cleanup.operation,
        });
      } catch (error) {
        observed = error;
      }
      return "optional check deferred";
    });
    const rejected = await inspection.catch((error: unknown) => error);
    expect(rejected).toBe(observed);
    if (cleanupFails) {
      expect(observed).toBeInstanceOf(AggregateError);
      expect(observed).toMatchObject({
        message: "SQLite snapshot allocation and cleanup failed",
        cause: failure,
        errors: [failure, cleanupFailure],
      });
    } else {
      expect(observed).toBe(failure);
    }
    await expect(withSqliteSnapshotFailureScope(async () => "healthy retry")).resolves.toBe(
      "healthy retry",
    );
  },
);

it("keeps an ordinary optional metadata error recoverable", async () => {
  await expect(
    withSqliteSnapshotFailureScope(async () => {
      try {
        throw new Error("optional ownership metadata unavailable");
      } catch {
        return "optional check deferred";
      }
    }),
  ).resolves.toBe("optional check deferred");
});
