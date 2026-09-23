import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";

// Callers retain ownership of assertion timing and restoration.
export function observeMainThreadSql() {
  const calls = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  return {
    expectIdle() {
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    },
    restore() {
      for (const call of calls) {
        call.mockRestore();
      }
    },
  };
}
