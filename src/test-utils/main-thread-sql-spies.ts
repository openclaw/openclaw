import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";

// Callers retain ownership of assertion timing and restoration.
export function observeMainThreadSql() {
  const execLocations: Array<string | null> = [];
  const execPrototype: { exec: (this: DatabaseSync, sql: string) => void } = DatabaseSync.prototype;
  const originalExec = execPrototype.exec;
  const exec = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql) {
      // Capture the real receiver while it is open; coordinator handles can close before assertion.
      execLocations.push(this.location());
      return originalExec.call(this, sql);
    });
  const dataCalls = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  const calls = [exec, ...dataCalls];
  return {
    expectIdle() {
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    },
    expectOnlyCoordinatorExec(databasePath: string, count: number) {
      for (const call of dataCalls) {
        expect(call).not.toHaveBeenCalled();
      }
      expect(exec).toHaveBeenCalledTimes(count);
      expect(execLocations).toEqual(Array.from({ length: count }, () => databasePath));
    },
    restore() {
      for (const call of calls) {
        call.mockRestore();
      }
    },
  };
}
