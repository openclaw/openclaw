import type { SqliteReadOnlyOperations } from "./sqlite-readonly-operation-registry.js";

const sqliteReadOnlyOperationProcessLifecycle = {
  // This read can borrow host-side schema maintenance. The pooled child transport
  // has process-lifetime admission, so its native exit is the release boundary.
  "startupMetadata.readCurrent": "retire-after-result",
} as const satisfies Partial<Record<keyof SqliteReadOnlyOperations, "retire-after-result">>;

export function sqliteReadOnlyOperationRequiresProcessRetirement(type: string): boolean {
  return type in sqliteReadOnlyOperationProcessLifecycle;
}
